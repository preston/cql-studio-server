// Author: Preston Lee

export const WorkspaceActivityVerb = {
  WorkspaceCreated: 'workspace.created',
  WorkspaceUpdated: 'workspace.updated',
  GrantUpserted: 'grant.upserted',
  GrantUpdated: 'grant.updated',
  GrantRemoved: 'grant.removed',
  EnvironmentShared: 'environment.shared',
  EnvironmentUpdated: 'environment.updated',
  EnvironmentRemoved: 'environment.removed',
  ResourceAdded: 'resource.added',
  ResourceRemoved: 'resource.removed',
} as const;

export type WorkspaceActivityVerb =
  (typeof WorkspaceActivityVerb)[keyof typeof WorkspaceActivityVerb];

export const WorkspaceActivityTargetType = {
  Workspace: 'workspace',
  Grant: 'grant',
  Environment: 'environment',
  Resource: 'resource',
} as const;

export type WorkspaceActivityTargetType =
  (typeof WorkspaceActivityTargetType)[keyof typeof WorkspaceActivityTargetType];
