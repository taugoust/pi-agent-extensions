export function selectSupervisorCwd(
  fixedRemoteCwd: string,
  targetCwd: string | undefined,
  contextCwd: string | undefined,
  processCwd: string,
) {
  return fixedRemoteCwd || targetCwd || contextCwd || processCwd;
}
