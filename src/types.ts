import type { ExecFileException } from "child_process"
import type { DB } from "./db"
import { Probot } from "probot"

export type PullRequestParams = {
  owner: string
  repo: string
  pull_number: number
}

export type PrepareBranchParams = {
  contributor: string
  owner: string
  repo: string
  branch: string
  repoPath: string
}

export type PullRequestTask = PullRequestParams & {
  installationId: number
  requester: string
  execPath: string
  args: string[]
  env: Record<string, string>
  prepareBranchParams: PrepareBranchParams
  commentId: number
  version: string
}

export type CommandOutput = Error | string

export type AppState = {
  version: string
  bot: Probot
  db: DB
  clientId: string
  clientSecret: string
  appId: number
  getFetchEndpoint: (
    installationId: number,
  ) => Promise<{ token: string; url: string }>
  log: (str: string) => void
  botMention: string
  nodesAddresses: Record<string, string>
  allowedOrganizations: number[]
}

export class PullRequestError {
  constructor(
    public params: PullRequestParams,
    public comment: {
      body: string
      commentId?: number
      requester?: string
    },
  ) {}
}