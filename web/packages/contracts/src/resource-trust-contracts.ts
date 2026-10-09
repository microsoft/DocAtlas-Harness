export interface ResourceFile { path: string, contentHash: string, byteLength: number, executable: boolean }
export interface ResourceSnapshot {
  schemaVersion: 1, kind: 'resource-snapshot', snapshotId: string, manifestHash: string, byteLength: number, files: ResourceFile[]
}
export interface ResourceApproval {
  schemaVersion: 1, kind: 'resource-approval', approvalId: string, actorId: string, workspaceId: string, snapshotId: string,
  manifestHash: string, state: 'approved' | 'revoked', version: number, updatedAt: string
}
export type ResourceTrustValue = ResourceSnapshot | ResourceApproval
