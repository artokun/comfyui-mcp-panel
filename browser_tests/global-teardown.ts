// #907 — see global-workflow-litter.ts. Runs once, after the last worker.
import { cleanWorkflowLitter } from './global-workflow-litter'

export default async function globalTeardown(): Promise<void> {
  await cleanWorkflowLitter()
}
