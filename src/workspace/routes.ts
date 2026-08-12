// Author: Preston Lee

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import {
  Prisma,
  WorkspacePrincipalType,
  WorkspaceRole,
  WorkspaceVisibility,
} from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import type { ServerEnv } from '../config/env.js';
import { requireAuth, requireSsoConfigured } from '../auth/session.js';
import {
  countOwners,
  listAccessibleWorkspaceIds,
  recordActivity,
  resolveEffectiveWorkspaceRole,
  roleAtLeast,
  uniqueSlug,
} from './access.js';

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function parseRole(raw: unknown): WorkspaceRole | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const upper = raw.toUpperCase();
  if (upper === 'OWNER' || upper === 'EDITOR' || upper === 'VIEWER') {
    return upper as WorkspaceRole;
  }
  return null;
}

function parsePrincipalType(raw: unknown): WorkspacePrincipalType | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const upper = raw.toUpperCase();
  if (upper === 'USER' || upper === 'TEAM') {
    return upper as WorkspacePrincipalType;
  }
  return null;
}

function stripSecretsFromConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') {
    return {};
  }
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const scrub = (endpoint: unknown) => {
    if (!endpoint || typeof endpoint !== 'object') {
      return endpoint;
    }
    const e = endpoint as Record<string, unknown>;
    delete e.basicAuthPassword;
    delete e.basicAuthUsername;
    return e;
  };
  if (clone.evaluationServer) {
    clone.evaluationServer = scrub(clone.evaluationServer);
  }
  if (clone.dataEndpoint) {
    clone.dataEndpoint = scrub(clone.dataEndpoint);
  }
  if (clone.terminologyEndpoint) {
    clone.terminologyEndpoint = scrub(clone.terminologyEndpoint);
  }
  if (clone.contentEndpoint) {
    clone.contentEndpoint = scrub(clone.contentEndpoint);
  }
  delete clone.basicAuthPassword;
  delete clone.basicAuthUsername;
  return clone;
}

export function createWorkspaceRouter(env: ServerEnv): Router {
  const router = Router();
  router.use(requireSsoConfigured(env));
  router.use(requireAuth(env));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const ids = await listAccessibleWorkspaceIds(req.user!);
      const workspaces = await getPrisma().workspace.findMany({
        where: { id: { in: ids } },
        orderBy: { updatedAt: 'desc' },
      });
      const withRoles = await Promise.all(
        workspaces.map(async (w) => ({
          ...w,
          myRole: await resolveEffectiveWorkspaceRole(req.user!, w.id),
        }))
      );
      res.json(withRoles);
    })
  );

  // Must be registered before /:id so "redeem" is not treated as an id
  router.post(
    '/redeem/:token',
    asyncHandler(async (req, res) => {
      const token = req.params.token;
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const link = await getPrisma().workspaceShareLink.findUnique({ where: { tokenHash } });
      if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) {
        res.status(404).json({ error: 'Share link invalid or expired' });
        return;
      }
      if (link.maxUses != null && link.useCount >= link.maxUses) {
        res.status(410).json({ error: 'Share link has reached its use limit' });
        return;
      }
      const grant = await getPrisma().workspaceAccessGrant.upsert({
        where: {
          workspaceId_principalType_principalId: {
            workspaceId: link.workspaceId,
            principalType: WorkspacePrincipalType.USER,
            principalId: req.user!.id,
          },
        },
        create: {
          workspaceId: link.workspaceId,
          principalType: WorkspacePrincipalType.USER,
          principalId: req.user!.id,
          role: WorkspaceRole.VIEWER,
          isGuest: true,
          grantedByUserId: link.createdByUserId,
        },
        update: {},
      });
      await getPrisma().workspaceShareLink.update({
        where: { id: link.id },
        data: { useCount: { increment: 1 } },
      });
      await recordActivity(
        link.workspaceId,
        req.user!.id,
        'share_link.redeemed',
        'grant',
        grant.id
      );
      res.json({ workspaceId: link.workspaceId, grant });
    })
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const user = req.user!;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      let visibility: WorkspaceVisibility = env.defaultWorkspaceVisibility;
      if (typeof req.body?.visibility === 'string') {
        const v = req.body.visibility.toUpperCase();
        if (v === 'PUBLIC') {
          if (!env.allowPublicWorkspaces) {
            res.status(400).json({ error: 'Public workspaces are disabled on this deployment' });
            return;
          }
          visibility = WorkspaceVisibility.PUBLIC;
        } else {
          visibility = WorkspaceVisibility.PRIVATE;
        }
      }
      const description =
        typeof req.body?.description === 'string' ? req.body.description.trim() : null;
      const slug = await uniqueSlug('workspace', name);
      const prisma = getPrisma();
      const workspace = await prisma.workspace.create({
        data: {
          name,
          slug,
          visibility,
          description,
          createdByUserId: user.id,
          grants: {
            create: {
              principalType: WorkspacePrincipalType.USER,
              principalId: user.id,
              role: WorkspaceRole.OWNER,
              grantedByUserId: user.id,
            },
          },
        },
      });
      await recordActivity(workspace.id, user.id, 'workspace.created', 'workspace', workspace.id);
      res.status(201).json({ ...workspace, myRole: WorkspaceRole.OWNER });
    })
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.VIEWER)) {
        res.status(role ? 403 : 404).json({ error: role ? 'Forbidden' : 'Workspace not found' });
        return;
      }
      const workspace = await getPrisma().workspace.findUnique({ where: { id: req.params.id } });
      if (!workspace) {
        res.status(404).json({ error: 'Workspace not found' });
        return;
      }
      res.json({ ...workspace, myRole: role });
    })
  );

  router.patch(
    '/:id',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const data: { name?: string; description?: string | null; visibility?: WorkspaceVisibility } =
        {};
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        data.name = req.body.name.trim();
      }
      if (req.body?.description === null || typeof req.body?.description === 'string') {
        data.description =
          typeof req.body.description === 'string' ? req.body.description.trim() : null;
      }
      if (typeof req.body?.visibility === 'string') {
        const v = req.body.visibility.toUpperCase();
        if (v === 'PUBLIC') {
          if (!env.allowPublicWorkspaces) {
            res.status(400).json({ error: 'Public workspaces are disabled on this deployment' });
            return;
          }
          data.visibility = WorkspaceVisibility.PUBLIC;
        } else if (v === 'PRIVATE') {
          data.visibility = WorkspaceVisibility.PRIVATE;
        }
      }
      const workspace = await getPrisma().workspace.update({
        where: { id: req.params.id },
        data,
      });
      await recordActivity(workspace.id, req.user!.id, 'workspace.updated', 'workspace', workspace.id);
      res.json({ ...workspace, myRole: role });
    })
  );

  router.delete(
    '/:id',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      await getPrisma().workspace.delete({ where: { id: req.params.id } });
      res.status(204).send();
    })
  );

  router.get(
    '/:id/grants',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.VIEWER)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const grants = await getPrisma().workspaceAccessGrant.findMany({
        where: { workspaceId: req.params.id },
        orderBy: { createdAt: 'asc' },
      });
      res.json(grants);
    })
  );

  router.post(
    '/:id/grants',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const principalType = parsePrincipalType(req.body?.type ?? req.body?.principalType);
      const principalId =
        typeof req.body?.id === 'string'
          ? req.body.id
          : typeof req.body?.principalId === 'string'
            ? req.body.principalId
            : '';
      const grantRole = parseRole(req.body?.role);
      if (!principalType || !principalId || !grantRole) {
        res.status(400).json({ error: 'type, id, and role are required' });
        return;
      }
      if (principalType === WorkspacePrincipalType.USER) {
        const u = await getPrisma().user.findUnique({ where: { id: principalId } });
        if (!u) {
          res.status(404).json({ error: 'User not found' });
          return;
        }
      } else {
        const t = await getPrisma().team.findUnique({ where: { id: principalId } });
        if (!t) {
          res.status(404).json({ error: 'Team not found' });
          return;
        }
      }
      const grant = await getPrisma().workspaceAccessGrant.upsert({
        where: {
          workspaceId_principalType_principalId: {
            workspaceId: req.params.id,
            principalType,
            principalId,
          },
        },
        create: {
          workspaceId: req.params.id,
          principalType,
          principalId,
          role: grantRole,
          grantedByUserId: req.user!.id,
        },
        update: { role: grantRole, grantedByUserId: req.user!.id },
      });
      await recordActivity(
        req.params.id,
        req.user!.id,
        'grant.upserted',
        'grant',
        grant.id,
        { principalType, principalId, role: grantRole }
      );
      res.status(201).json(grant);
    })
  );

  router.patch(
    '/:id/grants/:grantId',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const grantRole = parseRole(req.body?.role);
      if (!grantRole) {
        res.status(400).json({ error: 'role is required' });
        return;
      }
      const existing = await getPrisma().workspaceAccessGrant.findFirst({
        where: { id: req.params.grantId, workspaceId: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ error: 'Grant not found' });
        return;
      }
      if (
        existing.role === WorkspaceRole.OWNER &&
        grantRole !== WorkspaceRole.OWNER &&
        (await countOwners(req.params.id)) <= 1
      ) {
        res.status(409).json({ error: 'Workspace must have at least one owner' });
        return;
      }
      const grant = await getPrisma().workspaceAccessGrant.update({
        where: { id: existing.id },
        data: { role: grantRole },
      });
      await recordActivity(req.params.id, req.user!.id, 'grant.updated', 'grant', grant.id);
      res.json(grant);
    })
  );

  router.delete(
    '/:id/grants/:grantId',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const existing = await getPrisma().workspaceAccessGrant.findFirst({
        where: { id: req.params.grantId, workspaceId: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ error: 'Grant not found' });
        return;
      }
      if (existing.role === WorkspaceRole.OWNER && (await countOwners(req.params.id)) <= 1) {
        res.status(409).json({ error: 'Workspace must have at least one owner' });
        return;
      }
      await getPrisma().workspaceAccessGrant.delete({ where: { id: existing.id } });
      await recordActivity(req.params.id, req.user!.id, 'grant.removed', 'grant', existing.id);
      res.status(204).send();
    })
  );

  router.post(
    '/:id/share-links',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      let expiresAt: Date | null = null;
      if (req.body?.expiresInDays != null) {
        const days = Number(req.body.expiresInDays);
        if (!Number.isFinite(days) || days <= 0 || days > env.shareLinkMaxExpiryDays) {
          res.status(400).json({
            error: `expiresInDays must be between 1 and ${env.shareLinkMaxExpiryDays}`,
          });
          return;
        }
        expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      }
      const maxUses =
        req.body?.maxUses != null && Number.isFinite(Number(req.body.maxUses))
          ? Number(req.body.maxUses)
          : null;
      const link = await getPrisma().workspaceShareLink.create({
        data: {
          workspaceId: req.params.id,
          tokenHash,
          createdByUserId: req.user!.id,
          expiresAt: expiresAt ?? undefined,
          maxUses: maxUses ?? undefined,
        },
      });
      await recordActivity(req.params.id, req.user!.id, 'share_link.created', 'share_link', link.id);
      res.status(201).json({ ...link, token });
    })
  );

  router.get(
    '/:id/share-links',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const links = await getPrisma().workspaceShareLink.findMany({
        where: { workspaceId: req.params.id },
        orderBy: { createdAt: 'desc' },
      });
      res.json(links);
    })
  );

  router.delete(
    '/:id/share-links/:linkId',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.OWNER)) {
        res.status(403).json({ error: 'Owner role required' });
        return;
      }
      const link = await getPrisma().workspaceShareLink.findFirst({
        where: { id: req.params.linkId, workspaceId: req.params.id },
      });
      if (!link) {
        res.status(404).json({ error: 'Share link not found' });
        return;
      }
      await getPrisma().workspaceShareLink.update({
        where: { id: link.id },
        data: { revokedAt: new Date() },
      });
      res.status(204).send();
    })
  );

  router.get(
    '/:id/activity',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.VIEWER)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const take = Math.min(Number(req.query.limit) || 50, 100);
      const activity = await getPrisma().workspaceActivity.findMany({
        where: { workspaceId: req.params.id },
        include: { actor: { select: { id: true, email: true, displayName: true } } },
        orderBy: { createdAt: 'desc' },
        take,
      });
      res.json(activity);
    })
  );

  router.get(
    '/:id/environments',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.VIEWER)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const envs = await getPrisma().sharedEnvironment.findMany({
        where: { workspaceId: req.params.id },
        orderBy: { name: 'asc' },
      });
      res.json(envs);
    })
  );

  router.post(
    '/:id/environments',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.EDITOR)) {
        res.status(403).json({ error: 'Editor role required' });
        return;
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
      }
      const config = stripSecretsFromConfig(req.body?.config) as Prisma.InputJsonValue;
      const envRow = await getPrisma().sharedEnvironment.create({
        data: { workspaceId: req.params.id, name, config },
      });
      await recordActivity(
        req.params.id,
        req.user!.id,
        'environment.shared',
        'environment',
        envRow.id
      );
      res.status(201).json(envRow);
    })
  );

  router.patch(
    '/:id/environments/:envId',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.EDITOR)) {
        res.status(403).json({ error: 'Editor role required' });
        return;
      }
      const existing = await getPrisma().sharedEnvironment.findFirst({
        where: { id: req.params.envId, workspaceId: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ error: 'Environment not found' });
        return;
      }
      const data: { name?: string; config?: Prisma.InputJsonValue } = {};
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        data.name = req.body.name.trim();
      }
      if (req.body?.config !== undefined) {
        data.config = stripSecretsFromConfig(req.body.config) as Prisma.InputJsonValue;
      }
      const envRow = await getPrisma().sharedEnvironment.update({
        where: { id: existing.id },
        data,
      });
      res.json(envRow);
    })
  );

  router.delete(
    '/:id/environments/:envId',
    asyncHandler(async (req, res) => {
      const role = await resolveEffectiveWorkspaceRole(req.user!, req.params.id);
      if (!roleAtLeast(role, WorkspaceRole.EDITOR)) {
        res.status(403).json({ error: 'Editor role required' });
        return;
      }
      const existing = await getPrisma().sharedEnvironment.findFirst({
        where: { id: req.params.envId, workspaceId: req.params.id },
      });
      if (!existing) {
        res.status(404).json({ error: 'Environment not found' });
        return;
      }
      await getPrisma().sharedEnvironment.delete({ where: { id: existing.id } });
      res.status(204).send();
    })
  );

  return router;
}

export function createActivityRouter(env: ServerEnv): Router {
  const router = Router();
  router.use(requireSsoConfigured(env));
  router.use(requireAuth(env));

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const ids = await listAccessibleWorkspaceIds(req.user!);
      const take = Math.min(Number(req.query.limit) || 50, 100);
      const workspaceId =
        typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
      if (workspaceId && !ids.includes(workspaceId)) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      const activity = await getPrisma().workspaceActivity.findMany({
        where: {
          workspaceId: workspaceId ? workspaceId : { in: ids },
        },
        include: {
          actor: { select: { id: true, email: true, displayName: true } },
          workspace: { select: { id: true, name: true, slug: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
      });
      res.json(activity);
    })
  );

  return router;
}
