/** The GitHub account of a deployment, for code that runs only while the GitHub Source is on. */
import type { Deployment, GithubAccount } from './deployment.ts'

/** The GitHub account setup resolved; throws while the GitHub Source is off, when setup resolves none. */
export function githubOf(deployment: Pick<Deployment, 'repository' | 'github'>): GithubAccount & { repository: string } {
  if (!deployment.github || !deployment.repository) throw new Error('The GitHub Source is off, so dsh-superagent has no GitHub account')
  return { ...deployment.github, repository: deployment.repository }
}
