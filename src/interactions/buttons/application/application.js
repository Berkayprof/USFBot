import {
  handleApplyButton,
  handleStatusButton,
  handleDecisionButton,
  handleViewButton,
} from '../../../handlers/applicationHandlers.js';

// Custom IDs: app_apply:<roleId>, app_status, app_decide:<approve|deny>:<applicationId>, app_view:<applicationId>
export default [
  { name: 'app_apply', execute: handleApplyButton },
  { name: 'app_status', execute: handleStatusButton },
  { name: 'app_decide', execute: handleDecisionButton },
  { name: 'app_view', execute: handleViewButton },
];
