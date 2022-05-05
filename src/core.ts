import assert from "assert"

import { botPullRequestCommentMention } from "./bot"
import { ExtendedOctokit, isOrganizationMember } from "./github"
import { ShellExecutor } from "./shell"
import { Task } from "./task"
import { CommandExecutor, Context } from "./types"

export const defaultParseTryRuntimeBotCommandOptions = {
  baseEnv: { RUST_LOG: "remote-ext=info" },
}

export const parsePullRequestBotCommand = (
  commandLine: string,
  { baseEnv }: { baseEnv: Record<string, string> },
) => {
  const allTokens = commandLine.split(" ").filter((value) => {
    return !!value
  })

  const [firstToken, ...tokens] = allTokens

  if (firstToken !== botPullRequestCommentMention) {
    return
  }

  const args: string[] = []

  const env: Record<string, string> = { ...baseEnv }
  // envArgs are only collected at the start of the command line
  let isCollectingEnvVars = true

  for (const tok of tokens) {
    if (isCollectingEnvVars) {
      const matches = tok.match(/^([A-Za-z_]+)=(.*)/)
      if (matches === null) {
        isCollectingEnvVars = false
      } else {
        const [, name, value] = matches
        assert(name)
        env[name] = value
        continue
      }
    }
    args.push(tok)
  }

  return { args, env }
}

export const parsePullRequestBotCommandArgs = (
  { nodesAddresses }: Context,
  args: string[],
) => {
  // This expression catches the following forms: -foo=, --foo=
  const commandOptionExpression = /^-[^=\s]+=/

  // This expression catches the following forms: ws://foo, wss://foo, etc.
  const uriPrefixExpression = /^ws\w*:\/\//

  const nodeOptionsDisplay = `Available names are: ${Object.keys(
    nodesAddresses,
  ).join(", ")}.`

  const parsedArgs = []
  for (const rawArg of args) {
    const optionPrefix = commandOptionExpression.exec(rawArg)
    const { argPrefix, arg } =
      optionPrefix === null
        ? { argPrefix: "", arg: rawArg }
        : {
            argPrefix: optionPrefix[0],
            arg: rawArg.slice(optionPrefix[0].length),
          }

    const uriPrefixMatch = uriPrefixExpression.exec(arg)
    if (uriPrefixMatch === null) {
      parsedArgs.push(rawArg)
      continue
    }
    const [uriPrefix] = uriPrefixMatch

    const invalidNodeAddressExplanation = `Argument "${arg}" started with ${uriPrefix} and therefore it was interpreted as a node address, but it is invalid`

    const node = arg.slice(uriPrefix.length)
    if (!node) {
      return `${invalidNodeAddressExplanation}. Must specify one address in the form \`${uriPrefix}name\`. ${nodeOptionsDisplay}`
    }

    const nodeAddress = nodesAddresses[node]
    if (!nodeAddress) {
      return `${invalidNodeAddressExplanation}. Nodes are referred to by name. No node named "${node}" is available. ${nodeOptionsDisplay}`
    }

    parsedArgs.push(`${argPrefix}${nodeAddress}`)
  }

  return parsedArgs
}

export const getDeploymentsLogsMessage = ({ deployment }: Context) => {
  return deployment === undefined
    ? ""
    : `The logs for this command should be available on Grafana for the data source \`loki.${deployment.environment}\` and query \`{container=~"${deployment.container}"}\``
}

export const isRequesterAllowed = async (
  ctx: Context,
  octokit: ExtendedOctokit,
  username: string,
) => {
  const { allowedOrganizations } = ctx

  for (const organizationId of allowedOrganizations) {
    if (
      await isOrganizationMember(ctx, { organizationId, username, octokit })
    ) {
      return true
    }
  }

  return false
}

export const prepareBranch = async function* (
  ctx: Context,
  { repoPath, gitRef: { contributor, owner, repo, branch } }: Task,
  {
    getFetchEndpoint,
  }: {
    getFetchEndpoint: () => Promise<{ token: string; url: string }>
  },
) {
  const { token, url } = await getFetchEndpoint()

  const { run } = new ShellExecutor(ctx, {
    itemsToRedact: [token],
    shouldTrackProgress: false,
  })

  yield run("mkdir", ["-p", repoPath])

  const { run: runInRepo } = new ShellExecutor(ctx, {
    itemsToRedact: [token],
    shouldTrackProgress: false,
    cwd: repoPath,
  })

  // Clone the repository if it does not exist
  yield runInRepo(
    "git",
    ["clone", "--quiet", `${url}/${owner}/${repo}`, repoPath],
    {
      testAllowedErrorMessage: (err) => {
        return err.endsWith("already exists and is not an empty directory.")
      },
    },
  )

  // Clean up garbage files before checkout
  yield runInRepo("git", ["add", "."])
  yield runInRepo("git", ["reset", "--hard"])

  // Check out to the detached head so that any branch can be deleted
  const out = await runInRepo("git", ["rev-parse", "HEAD"])
  if (out instanceof Error) {
    return out
  }
  const detachedHead = out.trim()
  yield runInRepo("git", ["checkout", "--quiet", detachedHead], {
    testAllowedErrorMessage: (err) => {
      // Why the hell is this not printed to stdout?
      return err.startsWith("HEAD is now at")
    },
  })

  const prRemote = "pr"
  yield runInRepo("git", ["remote", "remove", prRemote], {
    testAllowedErrorMessage: (err) => {
      return err.includes("No such remote:")
    },
  })

  yield runInRepo("git", [
    "remote",
    "add",
    prRemote,
    `${url}/${contributor}/${repo}.git`,
  ])

  yield runInRepo("git", ["fetch", "--quiet", prRemote, branch])

  yield runInRepo("git", ["branch", "-D", branch], {
    testAllowedErrorMessage: (err) => {
      return err.endsWith("not found.")
    },
  })

  yield runInRepo("git", [
    "checkout",
    "--quiet",
    "--track",
    `${prRemote}/${branch}`,
  ])
}
