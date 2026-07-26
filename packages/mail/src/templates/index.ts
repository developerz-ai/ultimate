// Single responsibility: the framework's own transactional mails, gathered. `FRAMEWORK_MAILS`
// is what `x mail list` prints and what the i18n audit walks for missing keys.

import type { AnyMailDefinition } from '../mail';
import { inviteMail } from './invite';
import { mfaEnrolledMail } from './mfa-enrolled';
import { resetPasswordMail } from './reset-password';
import { securityAlertMail } from './security-alert';
import { verifyEmailMail } from './verify-email';
import { welcomeMail } from './welcome';

export { type InviteInput, inviteInput, inviteMail } from './invite';
export {
  MFA_METHODS,
  type MfaEnrolledInput,
  mfaEnrolledInput,
  mfaEnrolledMail,
} from './mfa-enrolled';
export {
  type ResetPasswordInput,
  resetPasswordInput,
  resetPasswordMail,
} from './reset-password';
export {
  type SecurityAlertInput,
  securityAlertInput,
  securityAlertMail,
} from './security-alert';
export { type VerifyEmailInput, verifyEmailInput, verifyEmailMail } from './verify-email';
export { type WelcomeInput, welcomeInput, welcomeMail } from './welcome';

export const FRAMEWORK_MAILS: readonly AnyMailDefinition[] = [
  welcomeMail,
  verifyEmailMail,
  resetPasswordMail,
  inviteMail,
  mfaEnrolledMail,
  securityAlertMail,
];
