// src/permissions/modes.ts
// 权限模式（影响决策管线起点的全局开关）。与 ConfigSchema.permissionMode 枚举一致。
//
// - default: 正常模式，按规则 + 工具类型决策（只读 allow / 写 ask）
// - acceptEdits: 自动放行 Edit/Write（但仍受 deny 规则约束）
// - plan: 规划模式，所有写操作直接 deny（不能改文件）
// - bypassPermissions: 全部放行（危险，沙箱内用）
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default'
