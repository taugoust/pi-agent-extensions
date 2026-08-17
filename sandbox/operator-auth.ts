export const AGENTSH_DETACHED_CONTROL_TOKEN_HEADER = "X-AgentSH-Detached-Control-Token";

export function detachedOperatorHeaders(path: string, token: string): Record<string, string> {
  const approvalPath = path === "/api/v1/approvals" || path.startsWith("/api/v1/approvals/");
  const credential = token.trim();
  if (!approvalPath || !credential) return {};
  return { [AGENTSH_DETACHED_CONTROL_TOKEN_HEADER]: credential };
}
