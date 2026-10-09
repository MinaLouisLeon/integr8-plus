export {
  tenantIdSchema,
  userIdSchema,
  platformUserIdSchema,
  toTenantId,
  toUserId,
  toPlatformUserId,
  type TenantId,
  type UserId,
  type PlatformUserId,
} from './ids.js';

export { ROLES, roleSchema, roleRank, hasAtLeastRole, type Role } from './roles.js';

export {
  PERMISSIONS,
  permissionSchema,
  can,
  assertCan,
  permissionsFor,
  permissionsHeld,
  holds,
  assertHolds,
  isStaffSeat,
  STAFF_ONLY_PERMISSIONS,
  type Seat,
  PermissionDeniedError,
  type Permission,
} from './permissions.js';

export {
  NAV_GROUPS,
  NAV_SECTIONS,
  PLATFORM_NAV_SECTIONS,
  visibleNavigation,
  type NavApp,
  type NavGroup,
  type NavIcon,
  type NavPath,
  type NavSection,
  type PlatformNavPath,
  type PlatformNavSection,
} from './navigation.js';

export {
  TOKEN_TYPES,
  tokenTypeSchema,
  impersonationClaimSchema,
  accessTokenClaimsSchema,
  platformTokenClaimsSchema,
  offlineGrantClaimsSchema,
  toPlatformPrincipal,
  toPrincipal,
  isImpersonating,
  type TokenType,
  type ImpersonationClaim,
  type AccessTokenClaims,
  type OfflineGrantClaims,
  type PlatformPrincipal,
  type PlatformTokenClaims,
  type Principal,
} from './claims.js';

export {
  InMemoryTokenStore,
  ACCESS_TOKEN_REFRESH_MARGIN_MS,
  shouldRefresh,
  requiresSignIn,
  canOpenOffline,
  type StoredTokens,
  type TokenStore,
} from './token-store.js';

export {
  APP_ENVIRONMENTS,
  appEnvironmentSchema,
  isProductionLike,
  requireEnv,
  optionalEnv,
  type AppEnvironment,
} from './environment.js';

export {
  APP_IDS,
  appIdSchema,
  appInfoSchema,
  describeApp,
  type AppId,
  type AppInfo,
} from './app-info.js';

export {
  WORK_ORDER_STATES,
  workOrderStateSchema,
  WORK_ORDER_PRIORITIES,
  workOrderPrioritySchema,
  WORK_ORDER_TRANSITIONS,
  CLOSED_WORK_ORDER_STATES,
  ACTIVE_WORK_ORDER_STATES,
  findTransition,
  nextStates,
  formatWorkOrderReference,
  type WorkOrderState,
  type WorkOrderPriority,
  type WorkOrderTransition,
} from './work-orders.js';

export {
  canComplete,
  completionMissing,
  jobTimes,
  shiftDurationMs,
  type CompletionFacts,
  type CompletionMissing,
  type JobTimes,
  type ShiftSpan,
  type StateChange,
} from './job-execution.js';
