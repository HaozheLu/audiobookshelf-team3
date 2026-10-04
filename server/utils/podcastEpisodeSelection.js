/**
 * @typedef PodcastDownloadFilters
 * @property {boolean} [excludeTrailers]
 * @property {boolean} [excludeBonusEpisodes]
 * @property {string} [excludeTitlePhrase]
 */

/**
 * Classify an RSS episode without fetching, saving, or queuing anything.
 * Reasons have a stable precedence: trailer, bonus, then title phrase.
 * @param {import('./podcastUtils').RssPodcastEpisode} episode
 * @param {PodcastDownloadFilters} [filters]
 */
function classifyPodcastEpisode(episode, filters = {}) {
  if (filters.excludeTrailers && episode.episodeType === 'trailer') {
    return { eligible: false, reason: 'trailer' }
  }
  if (filters.excludeBonusEpisodes && episode.episodeType === 'bonus') {
    return { eligible: false, reason: 'bonus' }
  }
  const phrase = typeof filters.excludeTitlePhrase === 'string' ? filters.excludeTitlePhrase.trim().toLowerCase() : ''
  const title = typeof episode.title === 'string' ? episode.title.toLowerCase() : ''
  if (phrase && title.includes(phrase)) {
    return { eligible: false, reason: 'title-phrase' }
  }
  return { eligible: true, reason: null }
}

/**
 * Shared automatic-download/preview selection over a supplied feed's episodes.
 * Keep feed order and delegate episode identity to the existing model check.
 * A rule-eligible episode can still be omitted by the count limit.
 * @param {import('./podcastUtils').RssPodcastEpisode[]} episodes
 * @param {number} cutoff
 * @param {(episode: import('./podcastUtils').RssPodcastEpisode) => boolean} hasEpisode
 * @param {number} [maxNewEpisodes]
 * @param {PodcastDownloadFilters} [filters]
 */
function selectPodcastEpisodes(episodes, cutoff, hasEpisode, maxNewEpisodes = 3, filters = {}) {
  const decisions = episodes.map((episode) => {
    if (!(episode.publishedAt > cutoff)) {
      return { episode, eligible: false, reason: 'date-cutoff', selected: false }
    }
    if (hasEpisode(episode)) {
      return { episode, eligible: false, reason: 'already-downloaded', selected: false }
    }
    return { episode, ...classifyPodcastEpisode(episode, filters), selected: false }
  })
  const eligible = decisions.filter((decision) => decision.eligible)
  const selected = maxNewEpisodes > 0 ? eligible.slice(0, maxNewEpisodes) : eligible
  selected.forEach((decision) => {
    decision.selected = true
  })
  eligible.forEach((decision) => {
    if (!decision.selected) decision.reason = 'count-limit'
  })
  return { episodes: selected.map((decision) => decision.episode), decisions }
}

/**
 * Match the automatic check's existing latest-episode/last-check fallback.
 * @param {import('../models/Podcast')} podcast
 * @returns {number}
 */
function getAutomaticEpisodeCutoff(podcast) {
  return podcast.getLatestEpisodePublishedAt() || podcast.lastEpisodeCheck?.valueOf() || 0
}

module.exports = { classifyPodcastEpisode, selectPodcastEpisodes, getAutomaticEpisodeCutoff }
