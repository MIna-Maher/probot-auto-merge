import { Application, Context } from 'probot'
import { getConfig } from 'probot-config'

const defaultConfig = {
  'min-approvals': 1,
  'max-requested-changes': 0
}

type Config = typeof defaultConfig

async function loadConfig(context: Context): Config {
  return await getConfig(context, 'auto-merge.yml', defaultConfig)
}

export = (app: Application) => {
  app.on([
    'pull_request.opened',
    'pull_request.reopened',
    'pull_request_review.submitted',
    'pull_request_review.dismissed',
    'pull_request.synchronize'
  ], async context => {
    await updatePullRequest(context, context.payload.pull_request as any, await loadConfig(context))
  })

  app.on([
    'check_run.created',
    'check_run.rerequested',
    'check_run.requested_action'
  ], async context => {
    await updateCheckPullRequests(context, context.payload.check_run.pull_requests, await loadConfig(context))
  })

  app.on([
    'check_suite.completed',
    'check_suite.requested',
    'check_suite.rerequested'
  ], async context => {
    await updateCheckPullRequests(context, context.payload.check_suite.pull_requests, await loadConfig(context))
  })

  async function updateCheckPullRequests(context: Context, pullRequests: CheckPullRequest[], config: Config) {
    for(const checkPullRequest of pullRequests) {
      const owner = context.payload.repository.owner.login
      const repo = context.payload.repository.name
      const number = checkPullRequest.number
      const pullRequestResponse = await context.github.pullRequests.get({owner, repo, number})
      const pullRequest = pullRequestResponse.data
      await updatePullRequest(context, pullRequest, config)
    }
  }

  async function updatePullRequest(context: Context, pullRequest: PullRequest, config: Config) {
    const repo = pullRequest.base.repo.name
    const owner = pullRequest.base.user.login
    const number = pullRequest.number

    function log(msg: string) {
      app.log(`${repo}/${owner} #${number}: ${msg}`)
    }

    if (pullRequest.state !== 'open') {
      log('Pull request not open')
      return
    }

    if (pullRequest.merged) {
      log('Pull request was already merged')
      return
    }

    if (!pullRequest.mergeable) {
      log('Pull request is not mergeable: ' + pullRequest.mergeable)
      return
    }

    const reviewsResponse = await context.github.pullRequests.getReviews({owner, repo, number})
    const reviews: Review[] = reviewsResponse.data
    const latestReviews: {
      [key: string]: ReviewState
    } = reviews
      .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime())
      .reduce((state, review) => ({
        ...state,
        [review.user.login]: review.state
      }), {})

    const reviewSummary = Object.entries(latestReviews)
      .map(([user, state]) => `${user}: ${state}`)
      .join('\n')

    log(`\nReviews:\n${reviewSummary}\n\n`)

    const reviewStates = Object.values(latestReviews)
    const changesRequestedCount = reviewStates.filter(reviewState => reviewState === 'CHANGES_REQUESTED').length
    if (changesRequestedCount > config["min-approvals"]) {
      log(`There are changes requested by a reviewer (${changesRequestedCount} / ${config["min-approvals"]})`)
      return
    }

    const approvalCount = reviewStates.filter(reviewState => reviewState === 'APPROVED').length
    if (approvalCount < config["max-requested-changes"]) {
      log(`There are not enough approvals by reviewers (${approvalCount} / ${config["max-requested-changes"]})`)
      return
    }
    const checksResponse = await context.github.checks.listForRef({owner, repo, ref: pullRequest.head.sha, filter: 'latest' })
    const checkRuns: CheckRun[] = checksResponse.data.check_runs
    // log('checks: ' + JSON.stringify(checks))
    const checksSummary = checkRuns.map(checkRun => `${checkRun.name}: ${checkRun.status}: ${checkRun.conclusion}`).join('\n')

    log(`\nChecks:\n${checksSummary}\n\n`)

    const allChecksCompleted = checkRuns.every(checkRun => checkRun.status === 'completed')
    if (!allChecksCompleted) {
      log(`There are still pending checks. Scheduling recheck.`)
      setTimeout(async () => {
        await updatePullRequest(context, pullRequest, config)
      }, 60000)
      return
    }
    const checkConclusions: {
      [conclusion: string]: boolean
    } = checkRuns.reduce((result, checkRun) => ({ ...result, [checkRun.conclusion]: true }), {})
    log('conclusions: ' + JSON.stringify(checkConclusions))
    const checksBlocking = checkConclusions.failure || checkConclusions.cancelled || checkConclusions.timed_out || checkConclusions.action_required
    if (checksBlocking) {
      log(`There are blocking checks`)
      return
    }
    await context.github.pullRequests.merge({owner, repo, number, merge_method: 'merge'})
    // await context.github.issues.createComment({owner, repo, number, body: 'I want to merge this right now'})
    log('Merge pull request')
  }
}
