import { Mutex } from "async-mutex"
import cp from "child_process"
import { isBefore, isValid, parseISO } from "date-fns"
import path from "path"
import { gitDir } from "src/constants"

import { DB, DbKey, getSortedItems } from "src/db"

import {
  PullRequestTask,
  PrepareBranchParams,
  CommandOutput,
  AppState,
} from "./types"
import { displayCommand, redactSecrets } from "./utils"

export const cancelHandles: Map<
  string,
  { cancel: () => Promise<void>; commentId: number; requester: string }
> = new Map()

export type ShellExecutor = (
  execPath: string,
  args: string[],
  opts?: {
    allowedErrorCodes?: number[]
    options?: cp.ExecFileOptions
    testAllowedErrorMessage?: (stderr: string) => boolean
    secretsToHide?: string[]
  },
) => Promise<CommandOutput>

export const getShellExecutor = function ({
  log,
  onChild,
}: {
  log: (str: string) => void
  onChild?: (child: cp.ChildProcess) => void
}): ShellExecutor {
  return function (
    execPath,
    args,
    { allowedErrorCodes, options, testAllowedErrorMessage, secretsToHide } = {},
  ) {
    return new Promise(function (resolve) {
      try {
        const commandDisplayed = displayCommand({
          execPath,
          args,
          secretsToHide: secretsToHide ?? [],
        })
        log(`Executing ${commandDisplayed}`)

        const child = cp.execFile(
          execPath,
          args,
          options,
          function (error, stdout, stderr) {
            const sanitizedStderr = redactSecrets(
              stderr.toString().trim(),
              secretsToHide,
            )
            const isErrorMessageAllowed = testAllowedErrorMessage
              ? testAllowedErrorMessage(sanitizedStderr)
              : false

            if (!isErrorMessageAllowed) {
              if (error) {
                const code = error.code as number | undefined
                if (code && !allowedErrorCodes?.includes(code)) {
                  return resolve(
                    new Error(
                      redactSecrets(
                        error.stack ?? error.message,
                        secretsToHide,
                      ),
                    ),
                  )
                }
              } else if (sanitizedStderr) {
                return resolve(new Error(sanitizedStderr))
              }
            }

            const sanitizedStdout = redactSecrets(
              stdout.toString().trim(),
              secretsToHide,
            )

            if (sanitizedStdout) {
              log(`Output of ${commandDisplayed}:\n${sanitizedStdout}`)
            }

            resolve(sanitizedStdout)
          },
        )

        if (onChild) {
          onChild(child)
        }
      } catch (error) {
        resolve(error)
      }
    })
  }
}

export const prepareBranch = async function* (
  { contributor, owner, repo, branch, repoPath }: PrepareBranchParams,
  {
    run,
    getFetchEndpoint,
  }: {
    run: ShellExecutor
    getFetchEndpoint: () => Promise<{ token: string; url: string }>
  },
) {
  yield run("mkdir", ["-p", repoPath])

  const { token, url } = await getFetchEndpoint()

  const repoCmd = function (
    ...[execPath, args, options]: Parameters<typeof run>
  ) {
    return run(execPath, args, {
      ...options,
      secretsToHide: [token, ...(options?.secretsToHide ?? [])],
      options: { cwd: repoPath, ...options?.options },
    })
  }

  yield repoCmd(
    "git",
    ["clone", "--quiet", `${url}/${owner}/${repo}`, repoPath],
    {
      testAllowedErrorMessage: function (err) {
        return err.endsWith("already exists and is not an empty directory.")
      },
    },
  )

  let out = await repoCmd("git", ["rev-parse", "HEAD"], {
    options: { cwd: repoPath },
  })
  if (out instanceof Error) {
    return out
  }

  // Check out to the detached head so that any branch can be deleted
  const detachedHead = out.trim()
  yield repoCmd("git", ["checkout", "--quiet", detachedHead], {
    testAllowedErrorMessage: function (err) {
      // Why the hell is this not printed to stdout?
      return err.startsWith("HEAD is now at")
    },
  })

  const prRemote = "pr"
  yield repoCmd("git", ["remote", "remove", prRemote], {
    testAllowedErrorMessage: function (err) {
      return err.startsWith("error: No such remote:")
    },
  })

  yield repoCmd("git", [
    "remote",
    "add",
    prRemote,
    `${url}/${contributor}/${repo}.git`,
  ])

  yield repoCmd("git", ["fetch", "--quiet", prRemote, branch])

  yield repoCmd("git", ["branch", "-D", branch], {
    testAllowedErrorMessage: function (err) {
      return err.endsWith("not found.")
    },
  })

  yield repoCmd("git", [
    "checkout",
    "--quiet",
    "--track",
    `${prRemote}/${branch}`,
  ])
}

export const getQueueMessage = async function (
  db: DB,
  commandDisplay: string,
  version: string,
) {
  const items = await getSortedItems(db, {
    match: { version },
  })

  if (items.length) {
    return `
Queued ${commandDisplay}

There are other items ahead of it in the queue: ${items.reduce(function (
      acc,
      value,
      i,
    ) {
      return `

${i + 1}:

\`\`\`
${JSON.stringify(value, null, 2)}
\`\`\`
  
`
    },
    "")}`
  } else {
    return `Executing ${commandDisplay}`
  }
}

const mutex = new Mutex()
export const queue = async function ({
  log,
  db,
  taskData,
  onResult,
  getFetchEndpoint,
  handleId,
}: Pick<AppState, "db" | "log" | "getFetchEndpoint"> & {
  taskData: PullRequestTask
  onResult: (result: CommandOutput) => Promise<void>
  handleId: string
}) {
  let child: cp.ChildProcess | undefined = undefined
  let isAlive = true
  const { execPath, args, prepareBranchParams, commentId, requester } = taskData
  const commandDisplay = displayCommand({ execPath, args, secretsToHide: [] })

  // Assuming the system clock is properly configured, this ID is guaranteed to
  // be unique due to the webhooks mutex's guarantees, because only one webhook
  // handler should execute at a time
  const taskId = new Date().toISOString()
  const message = await getQueueMessage(db, commandDisplay, taskData.version)
  const cancelledMessage = "Command was cancelled"

  const terminate = async function () {
    isAlive = false

    try {
      if (child) {
        log(`Killing child with PID ${child.pid} (${commandDisplay})`)
        child.kill()
      }
    } catch (err) {
      log(err)
    }

    await db.del(taskId)

    log(
      `Queue after termination: ${JSON.stringify(
        await getSortedItems(db, {
          match: { version: taskData.version },
        }),
      )}`,
    )
  }

  const afterExecution = async function (result: CommandOutput) {
    const wasAlive = isAlive

    await terminate()

    if (wasAlive) {
      onResult(result)
    }
  }

  await db.put(taskId, JSON.stringify(taskData))

  // This is queued one-at-a-time in the order that the webhooks' events are
  // received because they're expected to be executed through a mutex as well.
  mutex
    .runExclusive(async function () {
      try {
        log(
          `Starting run of ${commandDisplay}\nCurrent queue: ${JSON.stringify(
            await getSortedItems(db, {
              match: { version: taskData.version },
            }),
          )}`,
        )

        if (!isAlive) {
          return cancelledMessage
        }

        const run = getShellExecutor({
          log,
          onChild: function (newChild) {
            child = newChild
          },
        })

        const prepare = prepareBranch(prepareBranchParams, {
          run,
          getFetchEndpoint: function () {
            return getFetchEndpoint(taskData.installationId)
          },
        })
        let o: IteratorResult<CommandOutput>
        while (isAlive) {
          o = await prepare.next()

          if (o.done) {
            break
          }

          child = undefined

          if (typeof o.value !== "string") {
            return o.value
          }
        }
        if (!isAlive) {
          return cancelledMessage
        }

        const result = await run(execPath, args, {
          options: {
            env: { ...process.env, ...taskData.env },
            cwd: prepareBranchParams.repoPath,
          },
        })

        return isAlive
          ? `
Results are ready for ${commandDisplay}

<details>
<summary>Output</summary>

\`\`\`
${result}
\`\`\`

</details>
`
          : cancelledMessage
      } catch (err) {
        return err
      }
    })
    .then(afterExecution)
    .catch(afterExecution)

  cancelHandles.set(handleId, { cancel: terminate, commentId, requester })

  return message
}