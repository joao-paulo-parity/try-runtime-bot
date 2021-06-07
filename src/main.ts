import assert from "assert"
import { Probot, run } from "probot"
import { createAppAuth } from "@octokit/auth-app"
import { botMention } from "src/constants"

import { DB, getDb, getSortedItems } from "src/db"
import { queue } from "./executor"
import { getPostPullRequestResult, getPullRequestHandleId } from "./utils"

import { getWebhooksHandlers, setupEvent } from "./webhook"
import { AppState } from "./types"

const setupProbot = async function (state: AppState) {
  const { bot } = state

  const { onIssueCommentCreated } = getWebhooksHandlers(state)
  setupEvent(bot, "issue_comment.created", onIssueCommentCreated)
}

const requeueUnterminated = async function ({
  bot,
  getFetchEndpoint,
  db,
  version,
}: AppState) {
  // Items which are not from this version still remaining in the database are
  // deemed unterminated.
  const unterminatedItems = await getSortedItems(db, {
    match: { version, isInverseMatch: true },
  })

  for (const { taskData, id } of unterminatedItems) {
    await db.del(id)

    const octokit = await bot.auth(taskData.installationId)
    const handleId = getPullRequestHandleId(taskData)

    bot.log(`Requeuing ${JSON.stringify(taskData)}`)
    await queue({
      handleId,
      getFetchEndpoint,
      db,
      log: bot.log,
      taskData,
      onResult: getPostPullRequestResult({ taskData, octokit, handleId }),
    })
  }
}

const main = async function (bot: Probot) {
  const version = new Date().toISOString()

  const allowedOrganizations = (process.env.ALLOWED_ORGANIZATIONS ?? "")
    .split(",")
    .filter(function (value) {
      return value.length !== 0
    })
    .map(function (value) {
      const parsedValue = parseInt(value)
      assert(parsedValue)
      return parsedValue
    })
  assert(allowedOrganizations.length)

  assert(process.env.DB_PATH)
  const db = getDb(process.env.DB_PATH)

  assert(process.env.APP_ID)
  const appId = parseInt(process.env.APP_ID)
  assert(appId)

  assert(process.env.PRIVATE_KEY_BASE64)
  process.env.PRIVATE_KEY = Buffer.from(
    process.env.PRIVATE_KEY_BASE64,
    "base64",
  ).toString()
  assert(process.env.PRIVATE_KEY)

  assert(process.env.CLIENT_ID)
  const clientId = process.env.CLIENT_ID

  assert(process.env.CLIENT_SECRET)
  const clientSecret = process.env.CLIENT_SECRET

  const authInstallation = createAppAuth({
    appId,
    privateKey: process.env.PRIVATE_KEY,
    clientId,
    clientSecret,
  })

  const getFetchEndpoint = async function (installationId: number) {
    const token = (
      await authInstallation({
        type: "installation",
        installationId,
      })
    ).token

    const url = `https://x-access-token:${token}@github.com`

    return { url, token }
  }

  assert(process.env.ROCOCO_WEBSOCKET_ADDRESS)
  assert(process.env.WESTEND_WEBSOCKET_ADDRESS)
  assert(process.env.POLKADOT_WEBSOCKET_ADDRESS)
  assert(process.env.KUSAMA_WEBSOCKET_ADDRESS)

  const appState = {
    bot,
    db,
    appId,
    getFetchEndpoint,
    clientSecret,
    clientId,
    log: bot.log,
    botMention,
    version,
    nodesAddresses: {
      rococo: process.env.ROCOCO_WEBSOCKET_ADDRESS,
      westend: process.env.WESTEND_WEBSOCKET_ADDRESS,
      polkadot: process.env.POLKADOT_WEBSOCKET_ADDRESS,
      kusama: process.env.KUSAMA_WEBSOCKET_ADDRESS,
    },
    allowedOrganizations,
  }

  await requeueUnterminated(appState)
  setupProbot(appState)
}

run(main)