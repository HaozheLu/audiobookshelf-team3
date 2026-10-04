const Path = require('path')
const Logger = require('../Logger')
const SocketAuthority = require('../SocketAuthority')
const Database = require('../Database')
const Watcher = require('../Watcher')

const fs = require('../libs/fsExtra')

const { getPodcastFeed } = require('../utils/podcastUtils')
const { selectPodcastEpisodes, getAutomaticEpisodeCutoff } = require('../utils/podcastEpisodeSelection')
const { removeFile, downloadFile, sanitizeFilename, filePathToPOSIX, getFileTimestampsWithIno } = require('../utils/fileUtils')
const { levenshteinDistance } = require('../utils/index')
const opmlParser = require('../utils/parsers/parseOPML')
const opmlGenerator = require('../utils/generators/opmlGenerator')
const prober = require('../utils/prober')
const ffmpegHelpers = require('../utils/ffmpegHelpers')

const TaskManager = require('./TaskManager')
const CoverManager = require('../managers/CoverManager')
const NotificationManager = require('../managers/NotificationManager')

const LibraryFile = require('../objects/files/LibraryFile')
const PodcastEpisodeDownload = require('../objects/PodcastEpisodeDownload')
const AudioFile = require('../objects/files/AudioFile')

class PodcastManager {
  constructor() {
    /** @type {PodcastEpisodeDownload[]} */
    this.downloadQueue = []
    /** @type {PodcastEpisodeDownload} */
    this.currentDownload = null
    /** @type {PodcastEpisodeDownload[]} */
    this.failedDownloads = []
    this.MaxFailedDownloads = 50

    this.failedCheckMap = {}
    this.MaxFailedEpisodeChecks = global.MaxFailedEpisodeChecks
  }

  getEpisodeDownloadsInQueue(libraryItemId) {
    return this.downloadQueue.filter((d) => d.libraryItemId === libraryItemId)
  }

  clearDownloadQueue(libraryItemId = null) {
    if (!this.downloadQueue.length) return

    if (!libraryItemId) {
      Logger.info(`[PodcastManager] Clearing all downloads in queue (${this.downloadQueue.length})`)
      this.downloadQueue = []
    } else {
      var itemDownloads = this.getEpisodeDownloadsInQueue(libraryItemId)
      Logger.info(`[PodcastManager] Clearing downloads in queue for item "${libraryItemId}" (${itemDownloads.length})`)
      this.downloadQueue = this.downloadQueue.filter((d) => d.libraryItemId !== libraryItemId)
      SocketAuthority.emitter('episode_download_queue_cleared', libraryItemId)
    }
  }

  /**
   * Move a pending episode download to the front of the queue so it downloads next.
   * Only ever touches downloadQueue, never currentDownload.
   * @param {string} id - PodcastEpisodeDownload.id
   * @param {string} libraryItemId - the podcast the download must belong to
   * @returns {boolean} false if id is not currently in the waiting queue for this podcast (already active, finished, or already removed) - not an error
   */
  moveDownloadToFront(id, libraryItemId) {
    const index = this.downloadQueue.findIndex((d) => d.id === id && d.libraryItemId === libraryItemId)
    if (index < 0) return false

    const [download] = this.downloadQueue.splice(index, 1)
    this.downloadQueue.unshift(download)
    Logger.info(`[PodcastManager] Moved download "${download.episodeTitle}" to front of queue`)
    this.emitDownloadQueueUpdate()
    return true
  }

  /**
   * Remove a pending episode download from the queue before it starts.
   * Only ever touches downloadQueue, never currentDownload.
   * @param {string} id - PodcastEpisodeDownload.id
   * @param {string} libraryItemId - the podcast the download must belong to
   * @returns {boolean} false if id is not currently in the waiting queue for this podcast - not an error
   */
  removeFromDownloadQueue(id, libraryItemId) {
    const index = this.downloadQueue.findIndex((d) => d.id === id && d.libraryItemId === libraryItemId)
    if (index < 0) return false

    const [download] = this.downloadQueue.splice(index, 1)
    Logger.info(`[PodcastManager] Removed download "${download.episodeTitle}" from queue`)
    this.emitDownloadQueueUpdate()
    return true
  }

  /**
   * Broadcasts the full current queue snapshot so connected queue views stay in sync with the
   * server, which is the sole source of truth for download order.
   */
  emitDownloadQueueUpdate() {
    SocketAuthority.emitter('episode_download_queue_updated', this.getDownloadQueueDetails())
  }

  /**
   * Keep a bounded history of failed attempts for display and explicit retry.
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   */
  retainFailedDownload(podcastEpisodeDownload) {
    this.failedDownloads.push(podcastEpisodeDownload)
    if (this.failedDownloads.length > this.MaxFailedDownloads) {
      this.failedDownloads.splice(0, this.failedDownloads.length - this.MaxFailedDownloads)
    }
  }

  /**
   * Return the reason a new attempt cannot be accepted, or null when it is allowed.
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   * @returns {'already-active'|'already-queued'|'already-downloaded'|null}
   */
  getEpisodeDownloadRefusalReason(podcastEpisodeDownload) {
    if (this.currentDownload?.hasSameEpisodeIdentity(podcastEpisodeDownload)) {
      return 'already-active'
    }
    if (this.downloadQueue.some((download) => download.hasSameEpisodeIdentity(podcastEpisodeDownload))) {
      return 'already-queued'
    }
    if (podcastEpisodeDownload.libraryItem?.media?.checkHasEpisodeByFeedEpisode?.(podcastEpisodeDownload.rssPodcastEpisode)) {
      return 'already-downloaded'
    }
    return null
  }

  /**
   * Retry a retained failure using a fresh library item and a fresh download attempt.
   * @param {string} id - failed PodcastEpisodeDownload.id
   * @param {string} libraryId - library the failure must belong to
   */
  async retryFailedDownload(id, libraryId) {
    let failedDownload = this.failedDownloads.find((download) => download.id === id && download.libraryId === libraryId)
    if (!failedDownload) return { success: false, reason: 'failure-not-found' }

    const libraryItem = await Database.libraryItemModel.getExpandedById(failedDownload.libraryItemId)
    if (!libraryItem?.media || !libraryItem.isPodcast || libraryItem.libraryId !== libraryId) {
      return { success: false, reason: 'podcast-not-found' }
    }

    // Another request may have retried or dismissed this failure while the database lookup ran.
    failedDownload = this.failedDownloads.find((download) => download.id === id && download.libraryId === libraryId)
    if (!failedDownload) return { success: false, reason: 'failure-not-found' }

    const [retryResult] = this.downloadPodcastEpisodes(libraryItem, [failedDownload.rssPodcastEpisode], failedDownload.isAutoDownload)
    if (!retryResult.accepted) {
      return { success: false, reason: retryResult.reason }
    }

    this.failedDownloads = this.failedDownloads.filter((download) => download.id !== id)
    this.emitDownloadQueueUpdate()
    return {
      success: true,
      download: retryResult.download.toJSONForClient()
    }
  }

  /**
   * Dismiss one retained failure without changing active or queued downloads.
   * @param {string} id - failed PodcastEpisodeDownload.id
   * @param {string} libraryId - library the failure must belong to
   * @returns {boolean}
   */
  dismissFailedDownload(id, libraryId) {
    const index = this.failedDownloads.findIndex((download) => download.id === id && download.libraryId === libraryId)
    if (index < 0) return false

    this.failedDownloads.splice(index, 1)
    this.emitDownloadQueueUpdate()
    return true
  }

  /**
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {import('../utils/podcastUtils').RssPodcastEpisode[]} episodesToDownload
   * @param {boolean} isAutoDownload - If this download was triggered by auto download
   */
  downloadPodcastEpisodes(libraryItem, episodesToDownload, isAutoDownload) {
    const results = []
    for (const ep of episodesToDownload) {
      const newPeDl = new PodcastEpisodeDownload()
      newPeDl.setData(ep, libraryItem, isAutoDownload, libraryItem.libraryId)
      results.push(this.startPodcastEpisodeDownload(newPeDl))
    }
    return results
  }

  /**
   *
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   * @returns
   */
  startPodcastEpisodeDownload(podcastEpisodeDownload) {
    const refusalReason = this.getEpisodeDownloadRefusalReason(podcastEpisodeDownload)
    if (refusalReason) {
      Logger.warn(`[PodcastManager] Refused episode download "${podcastEpisodeDownload.episodeTitle}": ${refusalReason}`)
      return {
        accepted: false,
        reason: refusalReason,
        download: podcastEpisodeDownload
      }
    }

    if (this.currentDownload) {
      this.downloadQueue.push(podcastEpisodeDownload)
      SocketAuthority.emitter('episode_download_queued', podcastEpisodeDownload.toJSONForClient())
      return {
        accepted: true,
        state: 'queued',
        download: podcastEpisodeDownload,
        completion: null
      }
    }

    this.currentDownload = podcastEpisodeDownload
    podcastEpisodeDownload.setStarted()
    const completion = this.processPodcastEpisodeDownload(podcastEpisodeDownload)
    return {
      accepted: true,
      state: 'active',
      download: podcastEpisodeDownload,
      completion
    }
  }

  /**
   * Run one accepted attempt and always release its task and watcher state afterward.
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   * @returns {Promise<boolean>} whether the attempt succeeded
   */
  async processPodcastEpisodeDownload(podcastEpisodeDownload) {
    let task = null
    let success = false
    /** @type {'transfer'|'probing'|'persistence'} */
    let failureCategory = 'transfer'

    const taskData = {
      libraryId: podcastEpisodeDownload.libraryId,
      libraryItemId: podcastEpisodeDownload.libraryItemId
    }
    const taskTitleString = {
      text: 'Downloading episode',
      key: 'MessageDownloadingEpisode'
    }
    const taskDescriptionString = {
      text: `Downloading episode "${podcastEpisodeDownload.episodeTitle}".`,
      key: 'MessageTaskDownloadingEpisodeDescription',
      subs: [podcastEpisodeDownload.episodeTitle]
    }

    try {
      task = TaskManager.createAndAddTask('download-podcast-episode', taskTitleString, taskDescriptionString, false, taskData)
      SocketAuthority.emitter('episode_download_started', podcastEpisodeDownload.toJSONForClient())

      // If this file already exists then append a uuid to the filename
      //  e.g. "/tagesschau 20 Uhr.mp3" becomes "/tagesschau 20 Uhr (ep_asdfasdf).mp3"
      //  this handles podcasts where every title is the same (ref https://github.com/advplyr/audiobookshelf/issues/1802)
      if (await fs.pathExists(podcastEpisodeDownload.targetPath)) {
        podcastEpisodeDownload.setAppendRandomId(true)
      }

      // Ignores all added files to this dir
      Watcher.addIgnoreDir(podcastEpisodeDownload.libraryItem.path)
      Watcher.ignoreFilePathsDownloading.add(podcastEpisodeDownload.targetPath)

      // Make sure podcast library item folder exists
      if (!(await fs.pathExists(podcastEpisodeDownload.libraryItem.path))) {
        Logger.warn(`[PodcastManager] Podcast episode download: Podcast folder no longer exists at "${podcastEpisodeDownload.libraryItem.path}" - Creating it`)
        await fs.mkdir(podcastEpisodeDownload.libraryItem.path)
      }

      // Download episode and tag it
      const ffmpegDownloadResponse = await ffmpegHelpers.downloadPodcastEpisode(podcastEpisodeDownload).catch((error) => {
        Logger.error(`[PodcastManager] Podcast Episode download failed`, error)
      })
      success = !!ffmpegDownloadResponse?.success

      if (success) {
        const scanResult = await this.scanAddPodcastEpisodeAudioFile(podcastEpisodeDownload)
        success = scanResult.success
        if (!success) {
          failureCategory = scanResult.failureCategory
          Logger.error(`[PodcastManager] Failed to scan and add podcast episode audio file - removing file`)
          await this.removeFailedDownloadFile(podcastEpisodeDownload)
        }
      }

      // Preserve the existing fallback for ffmpeg or probing failures: download again without tagging.
      if (!success && !ffmpegDownloadResponse?.isRequestError && failureCategory !== 'persistence') {
        Logger.info(`[PodcastManager] Retrying episode download without tagging`)
        failureCategory = 'transfer'
        success = await this.downloadPodcastEpisodeWithoutTagging(podcastEpisodeDownload)
          .then(() => true)
          .catch((error) => {
            Logger.error(`[PodcastManager] Podcast Episode download failed`, error)
            return false
          })

        if (success) {
          const scanResult = await this.scanAddPodcastEpisodeAudioFile(podcastEpisodeDownload)
          success = scanResult.success
          if (!success) {
            failureCategory = scanResult.failureCategory
            Logger.error(`[PodcastManager] Failed to scan and add podcast episode audio file - removing file`)
            await this.removeFailedDownloadFile(podcastEpisodeDownload)
          }
        }
      }
    } catch (error) {
      Logger.error(`[PodcastManager] Unexpected podcast episode download failure`, error)
      success = false
    }

    try {
      if (success) {
        Logger.info(`[PodcastManager] Successfully downloaded podcast episode "${podcastEpisodeDownload.episodeTitle}"`)
        podcastEpisodeDownload.setFinished(true)
        task?.setFinished()
      } else {
        await this.removeFailedDownloadFile(podcastEpisodeDownload)
        podcastEpisodeDownload.setFinished(false, failureCategory)
        this.retainFailedDownload(podcastEpisodeDownload)
        task?.setFailed({
          text: 'Failed',
          key: 'MessageTaskFailed'
        })
      }
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to finalize podcast episode download state`, error)
    }

    try {
      if (task) TaskManager.taskFinished(task)
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to finalize podcast episode download task`, error)
    }

    try {
      SocketAuthority.emitter('episode_download_finished', podcastEpisodeDownload.toJSONForClient())
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to broadcast podcast episode download completion`, error)
    }

    try {
      Watcher.removeIgnoreDir(podcastEpisodeDownload.libraryItem.path)
      Watcher.ignoreFilePathsDownloading.delete(podcastEpisodeDownload.targetPath)
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to release podcast episode watcher state`, error)
    }

    if (this.currentDownload?.id === podcastEpisodeDownload.id) {
      this.currentDownload = null
    }
    if (this.downloadQueue.length) {
      this.startPodcastEpisodeDownload(this.downloadQueue.shift())
    }
    try {
      this.emitDownloadQueueUpdate()
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to broadcast podcast download queue update`, error)
    }
    return success
  }

  /**
   * Existing fallback: download the episode without ffmpeg metadata tagging.
   * Kept as a method so the workflow can be tested without making a network request.
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   */
  downloadPodcastEpisodeWithoutTagging(podcastEpisodeDownload) {
    return downloadFile(podcastEpisodeDownload.url, podcastEpisodeDownload.targetPath)
  }

  /**
   * Remove a failed attempt's partial file without allowing cleanup errors to stop the queue.
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   */
  async removeFailedDownloadFile(podcastEpisodeDownload) {
    await fs.remove(podcastEpisodeDownload.targetPath).catch((error) => {
      Logger.error(`[PodcastManager] Failed to remove partial podcast episode file "${podcastEpisodeDownload.targetPath}"`, error)
    })
  }

  /**
   * Scans the downloaded audio file, create the podcast episode, remove oldest episode if necessary
   * @param {PodcastEpisodeDownload} podcastEpisodeDownload
   * @returns {Promise<{success: boolean, failureCategory: 'probing'|'persistence'|null}>}
   */
  async scanAddPodcastEpisodeAudioFile(podcastEpisodeDownload = this.currentDownload) {
    let libraryFile = null
    let audioFile = null
    try {
      libraryFile = new LibraryFile()
      await libraryFile.setDataFromPath(podcastEpisodeDownload.targetPath, podcastEpisodeDownload.targetRelPath)
      audioFile = await this.probeAudioFile(libraryFile)
      if (!audioFile) {
        return { success: false, failureCategory: 'probing' }
      }
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to inspect downloaded podcast episode`, error)
      return { success: false, failureCategory: 'probing' }
    }

    let libraryItem = null
    let podcastEpisode = null
    try {
      libraryItem = await Database.libraryItemModel.getExpandedById(podcastEpisodeDownload.libraryItem.id)
      if (!libraryItem) {
        Logger.error(`[PodcastManager] Podcast Episode finished but library item was not found ${podcastEpisodeDownload.libraryItem.id}`)
        return { success: false, failureCategory: 'persistence' }
      }

      podcastEpisode = await Database.podcastEpisodeModel.createFromRssPodcastEpisode(podcastEpisodeDownload.rssPodcastEpisode, libraryItem.media.id, audioFile)

      libraryItem.libraryFiles.push(libraryFile.toJSON())
      // Re-calculating library item size because this wasnt being updated properly for podcasts in v2.20.0 and below
      let libraryItemSize = 0
      libraryItem.libraryFiles.forEach((lf) => {
        if (lf.metadata.size && !isNaN(lf.metadata.size)) {
          libraryItemSize += Number(lf.metadata.size)
        }
      })
      libraryItem.size = libraryItemSize
      libraryItem.changed('libraryFiles', true)

      libraryItem.media.podcastEpisodes.push(podcastEpisode)

      if (podcastEpisodeDownload.isAutoDownload) {
        // Check setting maxEpisodesToKeep and remove episode if necessary
        const numEpisodesWithPubDate = libraryItem.media.podcastEpisodes.filter((ep) => !!ep.publishedAt).length
        if (libraryItem.media.maxEpisodesToKeep && numEpisodesWithPubDate > libraryItem.media.maxEpisodesToKeep) {
          Logger.info(`[PodcastManager] # of episodes (${numEpisodesWithPubDate}) exceeds max episodes to keep (${libraryItem.media.maxEpisodesToKeep})`)
          const episodeToRemove = await this.getRemoveOldestEpisode(libraryItem, podcastEpisode.id)
          if (episodeToRemove) {
            // Remove episode from playlists
            await Database.playlistModel.removeMediaItemsFromPlaylists([episodeToRemove.id])
            // Remove media progress for this episode
            await Database.mediaProgressModel.destroy({
              where: {
                mediaItemId: episodeToRemove.id
              }
            })
            await episodeToRemove.destroy()
            libraryItem.media.podcastEpisodes = libraryItem.media.podcastEpisodes.filter((ep) => ep.id !== episodeToRemove.id)

            // Remove library file
            libraryItem.libraryFiles = libraryItem.libraryFiles.filter((lf) => lf.ino !== episodeToRemove.audioFile.ino)
          }
        }
      }

      await libraryItem.save()

      if (libraryItem.media.numEpisodes !== libraryItem.media.podcastEpisodes.length) {
        libraryItem.media.numEpisodes = libraryItem.media.podcastEpisodes.length
        await libraryItem.media.save()
      }
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to save downloaded podcast episode`, error)
      return { success: false, failureCategory: 'persistence' }
    }

    try {
      SocketAuthority.libraryItemEmitter('item_updated', libraryItem)
      const podcastEpisodeExpanded = podcastEpisode.toOldJSONExpanded(libraryItem.id)
      podcastEpisodeExpanded.libraryItem = libraryItem.toOldJSONExpanded()
      SocketAuthority.emitter('episode_added', podcastEpisodeExpanded)
    } catch (error) {
      Logger.error(`[PodcastManager] Failed to broadcast downloaded podcast episode`, error)
    }

    if (podcastEpisodeDownload.isAutoDownload) {
      // Notifications only for auto downloaded episodes
      NotificationManager.onPodcastEpisodeDownloaded(libraryItem, podcastEpisode)
    }

    return { success: true, failureCategory: null }
  }

  /**
   * Find oldest episode publishedAt and delete the audio file
   *
   * @param {import('../models/LibraryItem').LibraryItemExpanded} libraryItem
   * @param {string} episodeIdJustDownloaded
   * @returns {Promise<import('../models/PodcastEpisode')|null>} - Returns the episode to remove
   */
  async getRemoveOldestEpisode(libraryItem, episodeIdJustDownloaded) {
    let smallestPublishedAt = 0
    /** @type {import('../models/PodcastEpisode')} */
    let oldestEpisode = null

    /** @type {import('../models/PodcastEpisode')[]} */
    const podcastEpisodes = libraryItem.media.podcastEpisodes

    for (const ep of podcastEpisodes) {
      if (ep.id === episodeIdJustDownloaded || !ep.publishedAt) continue

      if (!smallestPublishedAt || ep.publishedAt < smallestPublishedAt) {
        smallestPublishedAt = ep.publishedAt
        oldestEpisode = ep
      }
    }

    if (oldestEpisode?.audioFile) {
      Logger.info(`[PodcastManager] Deleting oldest episode "${oldestEpisode.title}"`)
      const successfullyDeleted = await removeFile(oldestEpisode.audioFile.metadata.path)
      if (successfullyDeleted) {
        return oldestEpisode
      } else {
        Logger.warn(`[PodcastManager] Failed to remove oldest episode "${oldestEpisode.title}"`)
      }
    }
    return null
  }

  /**
   *
   * @param {LibraryFile} libraryFile
   * @returns {Promise<AudioFile|null>}
   */
  async probeAudioFile(libraryFile) {
    const path = libraryFile.metadata.path
    const mediaProbeData = await prober.probe(path)
    if (mediaProbeData.error) {
      Logger.error(`[PodcastManager] Podcast Episode downloaded but failed to probe "${path}"`, mediaProbeData.error)
      return null
    }
    const newAudioFile = new AudioFile()
    newAudioFile.setDataFromProbe(libraryFile, mediaProbeData)
    newAudioFile.index = 1
    return newAudioFile
  }

  /**
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @returns {Promise<boolean>} - Returns false if auto download episodes was disabled (disabled if reaches max failed checks)
   */
  async runEpisodeCheck(libraryItem) {
    const lastEpisodeCheck = libraryItem.media.lastEpisodeCheck?.valueOf() || 0
    const latestEpisodePublishedAt = libraryItem.media.getLatestEpisodePublishedAt()

    Logger.info(`[PodcastManager] runEpisodeCheck: "${libraryItem.media.title}" | Last check: ${new Date(lastEpisodeCheck)} | ${latestEpisodePublishedAt ? `Latest episode pubDate: ${new Date(latestEpisodePublishedAt)}` : 'No latest episode'}`)

    // Use latest episode pubDate if exists OR fallback to using lastEpisodeCheck
    //    lastEpisodeCheck will be the current time when adding a new podcast
    const dateToCheckForEpisodesAfter = getAutomaticEpisodeCutoff(libraryItem.media)
    Logger.debug(`[PodcastManager] runEpisodeCheck: "${libraryItem.media.title}" checking for episodes after ${new Date(dateToCheckForEpisodesAfter)}`)

    const newEpisodes = await this.checkPodcastForNewEpisodes(libraryItem, dateToCheckForEpisodesAfter, libraryItem.media.maxNewEpisodesToDownload, libraryItem.media)
    Logger.debug(`[PodcastManager] runEpisodeCheck: ${newEpisodes?.length || 'N/A'} episodes found`)

    if (!newEpisodes) {
      // Failed
      // Allow up to MaxFailedEpisodeChecks failed attempts before disabling auto download
      if (!this.failedCheckMap[libraryItem.id]) this.failedCheckMap[libraryItem.id] = 0
      this.failedCheckMap[libraryItem.id]++
      if (this.MaxFailedEpisodeChecks !== 0 && this.failedCheckMap[libraryItem.id] >= this.MaxFailedEpisodeChecks) {
        Logger.error(`[PodcastManager] runEpisodeCheck ${this.failedCheckMap[libraryItem.id]} failed attempts at checking episodes for "${libraryItem.media.title}" - disabling auto download`)
        void NotificationManager.onRSSFeedDisabled(libraryItem.media.feedURL, this.failedCheckMap[libraryItem.id], libraryItem.media.title)
        libraryItem.media.autoDownloadEpisodes = false
        delete this.failedCheckMap[libraryItem.id]
      } else {
        Logger.warn(`[PodcastManager] runEpisodeCheck ${this.failedCheckMap[libraryItem.id]} failed attempts at checking episodes for "${libraryItem.media.title}"`)
        void NotificationManager.onRSSFeedFailed(libraryItem.media.feedURL, this.failedCheckMap[libraryItem.id], libraryItem.media.title)
      }
    } else if (newEpisodes.length) {
      delete this.failedCheckMap[libraryItem.id]
      Logger.info(`[PodcastManager] Found ${newEpisodes.length} new episodes for podcast "${libraryItem.media.title}" - starting download`)
      this.downloadPodcastEpisodes(libraryItem, newEpisodes, true)
    } else {
      delete this.failedCheckMap[libraryItem.id]
      Logger.debug(`[PodcastManager] No new episodes for "${libraryItem.media.title}"`)
    }

    libraryItem.media.lastEpisodeCheck = new Date()
    await libraryItem.media.save()

    libraryItem.changed('updatedAt', true)
    await libraryItem.save()

    SocketAuthority.libraryItemEmitter('item_updated', libraryItem)

    return libraryItem.media.autoDownloadEpisodes
  }

  /**
   *
   * @param {import('../models/LibraryItem')} podcastLibraryItem
   * @param {number} dateToCheckForEpisodesAfter - Unix timestamp
   * @param {number} maxNewEpisodes
   * @param {import('../utils/podcastEpisodeSelection').PodcastDownloadFilters} [filters] - Supplied only for automatic checks
   * @returns {Promise<import('../utils/podcastUtils').RssPodcastEpisode[]|null>}
   */
  async checkPodcastForNewEpisodes(podcastLibraryItem, dateToCheckForEpisodesAfter, maxNewEpisodes = 3, filters = {}) {
    if (!podcastLibraryItem.media.feedURL) {
      Logger.error(`[PodcastManager] checkPodcastForNewEpisodes no feed url for ${podcastLibraryItem.media.title} (ID: ${podcastLibraryItem.id})`)
      return null
    }
    const feed = await Promise.race([
      getPodcastFeed(podcastLibraryItem.media.feedURL),
      new Promise((_, reject) =>
        // The added second is to make sure that axios can fail first and only falls back later
        setTimeout(() => reject(new Error('Timeout. getPodcastFeed seemed to timeout but not triggering the timeout.')), global.PodcastDownloadTimeout + 1000)
      )
    ]).catch((error) => {
      Logger.error(`[PodcastManager] checkPodcastForNewEpisodes failed to fetch feed for ${podcastLibraryItem.media.title} (ID: ${podcastLibraryItem.id}):`, error)
      return null
    })

    if (!feed?.episodes) {
      Logger.error(`[PodcastManager] checkPodcastForNewEpisodes invalid feed payload for ${podcastLibraryItem.media.title} (ID: ${podcastLibraryItem.id})`, feed)
      return null
    }

    return selectPodcastEpisodes(
      feed.episodes,
      dateToCheckForEpisodesAfter,
      (ep) => podcastLibraryItem.media.checkHasEpisodeByFeedEpisode(ep),
      maxNewEpisodes,
      filters
    ).episodes
  }

  /**
   * Read-only selection from a supplied feed and optional unsaved settings.
   * Request validation belongs to the controller. No feed fetch or state updates.
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {{ episodes: import('../utils/podcastUtils').RssPodcastEpisode[] }} feed
   * @param {import('../utils/podcastEpisodeSelection').PodcastDownloadFilters} [filters]
   * @param {number} [maxNewEpisodesToDownload]
   */
  previewAutomaticDownloads(libraryItem, feed, filters = {}, maxNewEpisodesToDownload = libraryItem.media.maxNewEpisodesToDownload) {
    const podcast = libraryItem.media
    const settings = {
      excludeTrailers: podcast.excludeTrailers,
      excludeBonusEpisodes: podcast.excludeBonusEpisodes,
      excludeTitlePhrase: podcast.excludeTitlePhrase,
      ...filters
    }
    const cutoff = getAutomaticEpisodeCutoff(podcast)
    const selection = selectPodcastEpisodes(feed.episodes, cutoff, (ep) => podcast.checkHasEpisodeByFeedEpisode(ep), maxNewEpisodesToDownload, settings)
    return { cutoff, ...selection }
  }

  /**
   *
   * @param {import('../models/LibraryItem')} libraryItem
   * @param {*} maxEpisodesToDownload
   * @returns {Promise<import('../utils/podcastUtils').RssPodcastEpisode[]>}
   */
  async checkAndDownloadNewEpisodes(libraryItem, maxEpisodesToDownload) {
    const lastEpisodeCheck = libraryItem.media.lastEpisodeCheck?.valueOf() || 0
    const lastEpisodeCheckDate = lastEpisodeCheck > 0 ? libraryItem.media.lastEpisodeCheck : 'Never'
    Logger.info(`[PodcastManager] checkAndDownloadNewEpisodes for "${libraryItem.media.title}" - Last episode check: ${lastEpisodeCheckDate}`)

    const newEpisodes = await this.checkPodcastForNewEpisodes(libraryItem, lastEpisodeCheck, maxEpisodesToDownload)
    if (newEpisodes?.length) {
      Logger.info(`[PodcastManager] Found ${newEpisodes.length} new episodes for podcast "${libraryItem.media.title}" - starting download`)
      this.downloadPodcastEpisodes(libraryItem, newEpisodes, false)
    } else {
      Logger.info(`[PodcastManager] No new episodes found for podcast "${libraryItem.media.title}"`)
    }

    libraryItem.media.lastEpisodeCheck = new Date()
    await libraryItem.media.save()

    libraryItem.changed('updatedAt', true)
    await libraryItem.save()

    SocketAuthority.libraryItemEmitter('item_updated', libraryItem)

    return newEpisodes || []
  }

  async findEpisode(rssFeedUrl, searchTitle) {
    const feed = await getPodcastFeed(rssFeedUrl).catch(() => {
      return null
    })
    if (!feed || !feed.episodes) {
      return null
    }

    const matches = []
    feed.episodes.forEach((ep) => {
      if (!ep.title) return

      const epTitle = ep.title.toLowerCase().trim()
      if (epTitle === searchTitle) {
        matches.push({
          episode: ep,
          levenshtein: 0
        })
      } else {
        const levenshtein = levenshteinDistance(searchTitle, epTitle, true)
        if (levenshtein <= 6 && epTitle.length > levenshtein) {
          matches.push({
            episode: ep,
            levenshtein
          })
        }
      }
    })
    return matches.sort((a, b) => a.levenshtein - b.levenshtein)
  }

  getParsedOPMLFileFeeds(opmlText) {
    return opmlParser.parse(opmlText)
  }

  async getOPMLFeeds(opmlText) {
    const extractedFeeds = opmlParser.parse(opmlText)
    if (!extractedFeeds?.length) {
      Logger.error('[PodcastManager] getOPMLFeeds: No RSS feeds found in OPML')
      return {
        error: 'No RSS feeds found in OPML'
      }
    }

    const rssFeedData = []

    for (let feed of extractedFeeds) {
      const feedData = await getPodcastFeed(feed.feedUrl, true)
      if (feedData) {
        feedData.metadata.feedUrl = feed.feedUrl
        rssFeedData.push(feedData)
      }
    }

    return {
      feeds: rssFeedData
    }
  }

  /**
   * OPML file string for podcasts in a library
   * @param {import('../models/Podcast')[]} podcasts
   * @returns {string} XML string
   */
  generateOPMLFileText(podcasts) {
    return opmlGenerator.generate(podcasts)
  }

  getDownloadQueueDetails(libraryId = null) {
    let _currentDownload = this.currentDownload
    if (libraryId && _currentDownload?.libraryId !== libraryId) _currentDownload = null

    return {
      currentDownload: _currentDownload?.toJSONForClient(),
      queue: this.downloadQueue.filter((item) => !libraryId || item.libraryId === libraryId).map((item) => item.toJSONForClient()),
      failedDownloads: this.failedDownloads.filter((item) => !libraryId || item.libraryId === libraryId).map((item) => item.toJSONForClient())
    }
  }

  /**
   *
   * @param {string[]} rssFeedUrls
   * @param {import('../models/LibraryFolder')} folder
   * @param {boolean} autoDownloadEpisodes
   * @param {import('../managers/CronManager')} cronManager
   */
  async createPodcastsFromFeedUrls(rssFeedUrls, folder, autoDownloadEpisodes, cronManager) {
    const taskTitleString = {
      text: 'OPML import',
      key: 'MessageTaskOpmlImport'
    }
    const taskDescriptionString = {
      text: `Creating podcasts from ${rssFeedUrls.length} RSS feeds`,
      key: 'MessageTaskOpmlImportDescription',
      subs: [rssFeedUrls.length]
    }
    const task = TaskManager.createAndAddTask('opml-import', taskTitleString, taskDescriptionString, true, null)
    let numPodcastsAdded = 0
    Logger.info(`[PodcastManager] createPodcastsFromFeedUrls: Importing ${rssFeedUrls.length} RSS feeds to folder "${folder.path}"`)
    for (const feedUrl of rssFeedUrls) {
      const feed = await getPodcastFeed(feedUrl).catch(() => null)
      if (!feed?.episodes) {
        const taskTitleStringFeed = {
          text: 'OPML import feed',
          key: 'MessageTaskOpmlImportFeed'
        }
        const taskDescriptionStringFeed = {
          text: `Importing RSS feed "${feedUrl}"`,
          key: 'MessageTaskOpmlImportFeedDescription',
          subs: [feedUrl]
        }
        const taskErrorString = {
          text: 'Failed to get podcast feed',
          key: 'MessageTaskOpmlImportFeedFailed'
        }
        TaskManager.createAndEmitFailedTask('opml-import-feed', taskTitleStringFeed, taskDescriptionStringFeed, taskErrorString)
        Logger.error(`[PodcastManager] createPodcastsFromFeedUrls: Failed to get podcast feed for "${feedUrl}"`)
        continue
      }

      const podcastFilename = sanitizeFilename(feed.metadata.title)
      const podcastPath = filePathToPOSIX(`${folder.path}/${podcastFilename}`)
      // Check if a library item with this podcast folder exists already
      const existingLibraryItem =
        (await Database.libraryItemModel.count({
          where: {
            path: podcastPath
          }
        })) > 0
      if (existingLibraryItem) {
        Logger.error(`[PodcastManager] createPodcastsFromFeedUrls: Podcast already exists at path "${podcastPath}"`)
        const taskTitleStringFeed = {
          text: 'OPML import feed',
          key: 'MessageTaskOpmlImportFeed'
        }
        const taskDescriptionStringPodcast = {
          text: `Creating podcast "${feed.metadata.title}"`,
          key: 'MessageTaskOpmlImportFeedPodcastDescription',
          subs: [feed.metadata.title]
        }
        const taskErrorString = {
          text: 'Podcast already exists at path',
          key: 'MessageTaskOpmlImportFeedPodcastExists'
        }
        TaskManager.createAndEmitFailedTask('opml-import-feed', taskTitleStringFeed, taskDescriptionStringPodcast, taskErrorString)
        continue
      }

      const successCreatingPath = await fs
        .ensureDir(podcastPath)
        .then(() => true)
        .catch((error) => {
          Logger.error(`[PodcastManager] Failed to ensure podcast dir "${podcastPath}"`, error)
          return false
        })
      if (!successCreatingPath) {
        Logger.error(`[PodcastManager] createPodcastsFromFeedUrls: Failed to create podcast folder at "${podcastPath}"`)
        const taskTitleStringFeed = {
          text: 'OPML import feed',
          key: 'MessageTaskOpmlImportFeed'
        }
        const taskDescriptionStringPodcast = {
          text: `Creating podcast "${feed.metadata.title}"`,
          key: 'MessageTaskOpmlImportFeedPodcastDescription',
          subs: [feed.metadata.title]
        }
        const taskErrorString = {
          text: 'Failed to create podcast folder',
          key: 'MessageTaskOpmlImportFeedPodcastFailed'
        }
        TaskManager.createAndEmitFailedTask('opml-import-feed', taskTitleStringFeed, taskDescriptionStringPodcast, taskErrorString)
        continue
      }

      let newLibraryItem = null
      const transaction = await Database.sequelize.transaction()
      try {
        const libraryItemFolderStats = await getFileTimestampsWithIno(podcastPath)

        const podcastPayload = {
          autoDownloadEpisodes,
          metadata: {
            title: feed.metadata.title,
            author: feed.metadata.author,
            description: feed.metadata.description,
            releaseDate: '',
            genres: [...feed.metadata.categories],
            feedUrl: feed.metadata.feedUrl,
            imageUrl: feed.metadata.image,
            itunesPageUrl: '',
            itunesId: '',
            itunesArtistId: '',
            language: '',
            numEpisodes: feed.numEpisodes
          }
        }
        const podcast = await Database.podcastModel.createFromRequest(podcastPayload, transaction)

        newLibraryItem = await Database.libraryItemModel.create(
          {
            ino: libraryItemFolderStats.ino,
            path: podcastPath,
            relPath: podcastFilename,
            mediaId: podcast.id,
            mediaType: 'podcast',
            isFile: false,
            isMissing: false,
            isInvalid: false,
            mtime: libraryItemFolderStats.mtimeMs || 0,
            ctime: libraryItemFolderStats.ctimeMs || 0,
            birthtime: libraryItemFolderStats.birthtimeMs || 0,
            size: 0,
            libraryFiles: [],
            extraData: {},
            libraryId: folder.libraryId,
            libraryFolderId: folder.id,
            title: podcast.title,
            titleIgnorePrefix: podcast.titleIgnorePrefix
          },
          { transaction }
        )

        await transaction.commit()
      } catch (error) {
        await transaction.rollback()
        Logger.error(`[PodcastManager] createPodcastsFromFeedUrls: Failed to create podcast library item for "${feed.metadata.title}"`, error)
        const taskTitleStringFeed = {
          text: 'OPML import feed',
          key: 'MessageTaskOpmlImportFeed'
        }
        const taskDescriptionStringPodcast = {
          text: `Creating podcast "${feed.metadata.title}"`,
          key: 'MessageTaskOpmlImportFeedPodcastDescription',
          subs: [feed.metadata.title]
        }
        const taskErrorString = {
          text: 'Failed to create podcast library item',
          key: 'MessageTaskOpmlImportFeedPodcastFailed'
        }
        TaskManager.createAndEmitFailedTask('opml-import-feed', taskTitleStringFeed, taskDescriptionStringPodcast, taskErrorString)
        continue
      }

      newLibraryItem.media = await newLibraryItem.getMediaExpanded()

      // Download and save cover image
      if (typeof feed.metadata.image === 'string' && feed.metadata.image.startsWith('http')) {
        // Podcast cover will always go into library item folder
        const coverResponse = await CoverManager.downloadCoverFromUrlNew(feed.metadata.image, newLibraryItem.id, newLibraryItem.path, true)
        if (coverResponse.error) {
          Logger.error(`[PodcastManager] Download cover error from "${feed.metadata.image}": ${coverResponse.error}`)
        } else if (coverResponse.cover) {
          const coverImageFileStats = await getFileTimestampsWithIno(coverResponse.cover)
          if (!coverImageFileStats) {
            Logger.error(`[PodcastManager] Failed to get cover image stats for "${coverResponse.cover}"`)
          } else {
            // Add libraryFile to libraryItem and coverPath to podcast
            const newLibraryFile = {
              ino: coverImageFileStats.ino,
              fileType: 'image',
              addedAt: Date.now(),
              updatedAt: Date.now(),
              metadata: {
                filename: Path.basename(coverResponse.cover),
                ext: Path.extname(coverResponse.cover).slice(1),
                path: coverResponse.cover,
                relPath: Path.basename(coverResponse.cover),
                size: coverImageFileStats.size,
                mtimeMs: coverImageFileStats.mtimeMs || 0,
                ctimeMs: coverImageFileStats.ctimeMs || 0,
                birthtimeMs: coverImageFileStats.birthtimeMs || 0
              }
            }
            newLibraryItem.libraryFiles.push(newLibraryFile)
            newLibraryItem.changed('libraryFiles', true)
            await newLibraryItem.save()

            newLibraryItem.media.coverPath = coverResponse.cover
            await newLibraryItem.media.save()
          }
        }
      }

      SocketAuthority.libraryItemEmitter('item_added', newLibraryItem)

      // Turn on podcast auto download cron if not already on
      if (newLibraryItem.media.autoDownloadEpisodes) {
        cronManager.checkUpdatePodcastCron(newLibraryItem)
      }

      numPodcastsAdded++
    }

    const taskFinishedString = {
      text: `Added ${numPodcastsAdded} podcasts`,
      key: 'MessageTaskOpmlImportFinished',
      subs: [numPodcastsAdded]
    }
    task.setFinished(taskFinishedString)
    TaskManager.taskFinished(task)
    Logger.info(`[PodcastManager] createPodcastsFromFeedUrls: Finished OPML import. Created ${numPodcastsAdded} podcasts out of ${rssFeedUrls.length} RSS feed URLs`)
  }
}
module.exports = PodcastManager
