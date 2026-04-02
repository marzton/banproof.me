// ============================================================
// @goldshore/database — Public exports
// ============================================================

export type {
  UserRole,
  PlanTier,
  SubStatus,
  SignalType,
  ProjectType,
  InquiryStatus,
  AdminAction,
  PlatformUser,
  PlatformSession,
  PlatformSubscription,
  Inquiry,
  Signal,
  AuditLogEntry,
  AdminAuditEntry,
  PublicUser,
} from './types.js';

export {
  // Users
  getUserByEmail,
  getUserById,
  createUser,
  updateUserTier,
  listUsers,
  // Sessions
  createSession,
  getSessionByAccessToken,
  getSessionByRefreshToken,
  revokeUserSessions,
  updateSessionAccessToken,
  // Signals
  createSignal,
  getSignalsByUser,
  // Inquiries
  createInquiry,
  updateInquiryStatus,
  getInquiry,
  // Audit
  writeAuditLog,
  pruneAuditLog,
  writeAdminAuditLog,
  getAdminAuditLog,
  // Stats
  getDashboardStats,
} from './client.js';
