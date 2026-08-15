// #907 — see global-workflow-litter.ts. Runs once, before any worker.
import { recordWorkflowBaseline } from './global-workflow-litter'

export default async function globalSetup(): Promise<void> {
  await recordWorkflowBaseline()
}
