export const getAgentDir = () => process.env.PI_CODING_AGENT_DIR;
export const { withFileMutationQueue } = await import(process.env.PI_QUEUE_MODULE);
