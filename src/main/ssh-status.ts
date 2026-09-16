/**
 * systemSsh 传输层的状态判定（纯函数，无 Electron 依赖，可独立编译自测）。
 */

/**
 * 判定 systemSsh 会话是否可以翻转为 connected。
 *
 * 规则：当前输出不是认证提示，且
 * - 没有待提交的凭据（无需交互认证，或凭据已提交），或
 * - 虽有凭据待提交，但已经见过认证提示（说明认证阶段已走完）。
 *
 * 注意：只要服务器的认证提示形态与正则对不上（自定义键盘交互文案、配置了
 * 私钥口令但服务端未启用等），这里会一直返回 false —— 因此主进程还必须
 * 配合「首段输出后仍卡在 connecting 的超时兜底」，绝不能让状态永久卡死。
 */
export function shouldMarkConnected(state: {
  authPromptSeen: boolean;
  passwordSent: boolean;
  passphraseSent: boolean;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  hasPassphrase: boolean;
  tailEndsWithAuthPrompt: boolean;
}): boolean {
  const awaitingCredentials =
    (!state.hasPrivateKey && state.hasPassword && !state.passwordSent) ||
    (state.hasPrivateKey && state.hasPassphrase && !state.passphraseSent);
  return !state.tailEndsWithAuthPrompt && (!awaitingCredentials || state.authPromptSeen);
}
