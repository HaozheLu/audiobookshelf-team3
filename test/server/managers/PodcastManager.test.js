const { expect } = require('chai')
const sinon = require('sinon')
const SocketAuthority = require('../../../server/SocketAuthority')
const Database = require('../../../server/Database')
const Logger = require('../../../server/Logger')
const Watcher = require('../../../server/Watcher')
const fs = require('../../../server/libs/fsExtra')
const ffmpegHelpers = require('../../../server/utils/ffmpegHelpers')
const TaskManager = require('../../../server/managers/TaskManager')
const PodcastManager = require('../../../server/managers/PodcastManager')
const PodcastEpisodeDownload = require('../../../server/objects/PodcastEpisodeDownload')

describe('PodcastManager', () => {
  let podcastManager
  let emitterStub

  function createDownload(id, overrides = {}) {
    return {
      id,
      libraryId: 'lib-1',
      libraryItemId: 'item-1',
      episodeTitle: `Episode ${id}`,
      toJSONForClient: () => ({ id, ...overrides }),
      ...overrides
    }
  }

  function createFeedEpisode(id, overrides = {}) {
    return {
      title: `Episode ${id}`,
      guid: `guid-${id}`,
      enclosure: {
        url: `https://example.com/${id}.mp3`,
        type: 'audio/mpeg',
        length: '100'
      },
      ...overrides
    }
  }

  function createLibraryItem(overrides = {}) {
    const media = {
      title: 'Test Podcast',
      explicit: false,
      podcastEpisodes: [],
      checkHasEpisodeByFeedEpisode(feedEpisode) {
        return this.podcastEpisodes.some((episode) => {
          if (episode.guid && feedEpisode.guid) return episode.guid === feedEpisode.guid
          return episode.enclosureURL === feedEpisode.enclosure.url
        })
      },
      ...overrides.media
    }
    return {
      id: 'item-1',
      libraryId: 'lib-1',
      path: '/podcasts/test',
      isPodcast: true,
      media,
      ...overrides,
      media
    }
  }

  function createEpisodeDownload(id, overrides = {}) {
    const libraryItem = overrides.libraryItem || createLibraryItem()
    const feedEpisode = overrides.feedEpisode || createFeedEpisode(id)
    const download = new PodcastEpisodeDownload()
    download.setData(feedEpisode, libraryItem, !!overrides.isAutoDownload, libraryItem.libraryId)
    download.id = id
    return download
  }

  beforeEach(() => {
    podcastManager = new PodcastManager()
    emitterStub = sinon.stub(SocketAuthority, 'emitter')
    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
  })

  afterEach(() => {
    sinon.restore()
  })

  describe('moveDownloadToFront', () => {
    it('moves an entry from the middle of the queue to the front', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2'), createDownload('d3')]

      const result = podcastManager.moveDownloadToFront('d2', 'item-1')

      expect(result).to.be.true
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d2', 'd1', 'd3'])
      expect(emitterStub.calledOnceWith('episode_download_queue_updated')).to.be.true
    })

    it('is a harmless no-op when the entry is already at the front', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2')]

      const result = podcastManager.moveDownloadToFront('d1', 'item-1')

      expect(result).to.be.true
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d1', 'd2'])
    })

    it('returns false without throwing when the id is not in the queue', () => {
      podcastManager.downloadQueue = [createDownload('d1')]

      const result = podcastManager.moveDownloadToFront('does-not-exist', 'item-1')

      expect(result).to.be.false
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d1'])
      expect(emitterStub.called).to.be.false
    })

    it('returns false and leaves currentDownload untouched when the id belongs to the active download', () => {
      const current = createDownload('active')
      podcastManager.currentDownload = current
      podcastManager.downloadQueue = [createDownload('d1')]

      const result = podcastManager.moveDownloadToFront('active', 'item-1')

      expect(result).to.be.false
      expect(podcastManager.currentDownload).to.equal(current)
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d1'])
      expect(emitterStub.called).to.be.false
    })

    it('returns false when the entry exists but belongs to a different podcast', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2')]

      const result = podcastManager.moveDownloadToFront('d2', 'some-other-item')

      expect(result).to.be.false
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d1', 'd2'])
      expect(emitterStub.called).to.be.false
    })
  })

  describe('removeFromDownloadQueue', () => {
    it('removes an entry from the queue', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2')]

      const result = podcastManager.removeFromDownloadQueue('d1', 'item-1')

      expect(result).to.be.true
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d2'])
      expect(emitterStub.calledOnceWith('episode_download_queue_updated')).to.be.true
    })

    it('returns false without throwing when the id is not in the queue', () => {
      podcastManager.downloadQueue = [createDownload('d1')]

      const result = podcastManager.removeFromDownloadQueue('does-not-exist', 'item-1')

      expect(result).to.be.false
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d1'])
    })

    it('is idempotent when called twice in a row for the same id (duplicate request)', () => {
      podcastManager.downloadQueue = [createDownload('d1')]

      const first = podcastManager.removeFromDownloadQueue('d1', 'item-1')
      const second = podcastManager.removeFromDownloadQueue('d1', 'item-1')

      expect(first).to.be.true
      expect(second).to.be.false
      expect(podcastManager.downloadQueue).to.deep.equal([])
    })

    it('returns false and leaves currentDownload untouched when the id belongs to the active download', () => {
      const current = createDownload('active')
      podcastManager.currentDownload = current

      const result = podcastManager.removeFromDownloadQueue('active', 'item-1')

      expect(result).to.be.false
      expect(podcastManager.currentDownload).to.equal(current)
    })

    it('returns false when the entry exists but belongs to a different podcast', () => {
      podcastManager.downloadQueue = [createDownload('d1')]

      const result = podcastManager.removeFromDownloadQueue('d1', 'some-other-item')

      expect(result).to.be.false
      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d1'])
      expect(emitterStub.called).to.be.false
    })

    it('does not lose a new episode queued concurrently with another operation', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2')]

      podcastManager.removeFromDownloadQueue('d1', 'item-1')
      // Simulate a new episode being pushed onto the queue right after
      podcastManager.downloadQueue.push(createDownload('d3'))

      expect(podcastManager.downloadQueue.map((d) => d.id)).to.deep.equal(['d2', 'd3'])
    })
  })

  describe('emitDownloadQueueUpdate', () => {
    it('broadcasts the full queue snapshot from getDownloadQueueDetails', () => {
      podcastManager.downloadQueue = [createDownload('d1')]
      podcastManager.currentDownload = createDownload('active')

      podcastManager.emitDownloadQueueUpdate()

      expect(emitterStub.calledOnce).to.be.true
      const [eventName, payload] = emitterStub.firstCall.args
      expect(eventName).to.equal('episode_download_queue_updated')
      expect(payload.queue.map((d) => d.id)).to.deep.equal(['d1'])
      expect(payload.currentDownload.id).to.equal('active')
    })
  })

  describe('the server owns queue order', () => {
    it('order shown to a freshly loaded queue page matches the order downloads actually start in', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2'), createDownload('d3'), createDownload('d4'), createDownload('d5')]

      podcastManager.moveDownloadToFront('d4', 'item-1')
      podcastManager.removeFromDownloadQueue('d2', 'item-1')

      // What a freshly loaded page renders: LibraryController.getEpisodeDownloadQueue -> getDownloadQueueDetails
      const freshPageOrder = podcastManager.getDownloadQueueDetails().queue.map((d) => d.id)

      // The order the server starts downloads in: downloadQueue.shift() when the active download finishes
      const startOrder = []
      while (podcastManager.downloadQueue.length) {
        startOrder.push(podcastManager.downloadQueue.shift().id)
      }

      expect(freshPageOrder).to.deep.equal(['d4', 'd1', 'd3', 'd5'])
      expect(freshPageOrder).to.deep.equal(startOrder)
    })

    it('broadcast payload matches a fresh page load so other open sessions converge on the same order', () => {
      podcastManager.downloadQueue = [createDownload('d1'), createDownload('d2'), createDownload('d3')]

      podcastManager.moveDownloadToFront('d3', 'item-1')

      const [eventName, broadcast] = emitterStub.firstCall.args
      expect(eventName).to.equal('episode_download_queue_updated')
      // A session that only receives the broadcast ends up with the same order as one that reloads
      expect(broadcast.queue.map((d) => d.id)).to.deep.equal(podcastManager.getDownloadQueueDetails().queue.map((d) => d.id))
    })
  })

  describe('failed download history', () => {
    it('starts empty and retains only the latest 50 failures', () => {
      expect(podcastManager.failedDownloads).to.deep.equal([])

      for (let index = 0; index < 55; index++) {
        const download = createEpisodeDownload(`failure-${index}`)
        download.setFinished(false, 'transfer')
        podcastManager.retainFailedDownload(download)
      }

      expect(podcastManager.failedDownloads).to.have.length(50)
      expect(podcastManager.failedDownloads[0].id).to.equal('failure-5')
      expect(podcastManager.failedDownloads[49].id).to.equal('failure-54')
    })

    it('includes failures in fresh queue details and filters them by library', () => {
      const first = createEpisodeDownload('failure-1')
      first.setFinished(false, 'probing')
      const second = createEpisodeDownload('failure-2', {
        libraryItem: createLibraryItem({ id: 'item-2', libraryId: 'lib-2' })
      })
      second.setFinished(false, 'persistence')
      podcastManager.failedDownloads = [first, second]

      const details = podcastManager.getDownloadQueueDetails('lib-1')

      expect(details.failedDownloads).to.have.length(1)
      expect(details.failedDownloads[0]).to.include({ id: 'failure-1', failureCategory: 'probing' })
    })

    it('dismisses only the selected failure from the requested library', () => {
      const first = createEpisodeDownload('failure-1')
      const second = createEpisodeDownload('failure-2')
      podcastManager.failedDownloads = [first, second]

      expect(podcastManager.dismissFailedDownload('failure-1', 'other-library')).to.be.false
      expect(podcastManager.failedDownloads.map((download) => download.id)).to.deep.equal(['failure-1', 'failure-2'])

      expect(podcastManager.dismissFailedDownload('failure-1', 'lib-1')).to.be.true
      expect(podcastManager.failedDownloads.map((download) => download.id)).to.deep.equal(['failure-2'])
      expect(emitterStub.calledOnceWith('episode_download_queue_updated')).to.be.true
    })
  })

  describe('retryFailedDownload', () => {
    function stubLibraryItemLookup(libraryItem) {
      const getExpandedById = sinon.stub().resolves(libraryItem)
      sinon.stub(Database, 'libraryItemModel').get(() => ({ getExpandedById }))
      return getExpandedById
    }

    function retainFailure(id = 'failed-attempt', overrides = {}) {
      const failure = createEpisodeDownload(id, overrides)
      failure.setStarted()
      failure.setFinished(false, 'transfer')
      podcastManager.retainFailedDownload(failure)
      return failure
    }

    it('creates a fresh attempt and removes the old failure after acceptance', async () => {
      const libraryItem = createLibraryItem()
      const failure = retainFailure('old-attempt', { libraryItem })
      stubLibraryItemLookup(libraryItem)
      sinon.stub(podcastManager, 'processPodcastEpisodeDownload').returns(new Promise(() => {}))

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result.success).to.be.true
      expect(result.download.id).to.not.equal(failure.id)
      expect(podcastManager.currentDownload.id).to.equal(result.download.id)
      expect(podcastManager.failedDownloads).to.deep.equal([])
      expect(failure.id).to.equal('old-attempt')
      expect(failure.failed).to.be.true
    })

    it('accepts only one of two rapid retry requests', async () => {
      const libraryItem = createLibraryItem()
      const failure = retainFailure('old-attempt', { libraryItem })
      stubLibraryItemLookup(libraryItem)
      sinon.stub(podcastManager, 'processPodcastEpisodeDownload').returns(new Promise(() => {}))

      const results = await Promise.all([podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId), podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)])

      expect(results.filter((result) => result.success)).to.have.length(1)
      expect(results.filter((result) => result.reason === 'failure-not-found')).to.have.length(1)
      expect(podcastManager.downloadQueue).to.have.length(0)
    })

    it('keeps the failure when the episode is already active', async () => {
      const libraryItem = createLibraryItem()
      const feedEpisode = createFeedEpisode('same')
      const failure = retainFailure('failed-attempt', { libraryItem, feedEpisode })
      podcastManager.currentDownload = createEpisodeDownload('active-attempt', { libraryItem, feedEpisode })
      stubLibraryItemLookup(libraryItem)

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result).to.deep.equal({ success: false, reason: 'already-active' })
      expect(podcastManager.failedDownloads).to.deep.equal([failure])
    })

    it('keeps the failure when the episode is already queued', async () => {
      const libraryItem = createLibraryItem()
      const feedEpisode = createFeedEpisode('same')
      const failure = retainFailure('failed-attempt', { libraryItem, feedEpisode })
      podcastManager.currentDownload = createEpisodeDownload('other-active', { libraryItem, feedEpisode: createFeedEpisode('other') })
      podcastManager.downloadQueue = [createEpisodeDownload('queued-attempt', { libraryItem, feedEpisode })]
      stubLibraryItemLookup(libraryItem)

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result).to.deep.equal({ success: false, reason: 'already-queued' })
      expect(podcastManager.failedDownloads).to.deep.equal([failure])
    })

    it('keeps the failure when the episode is already downloaded', async () => {
      const feedEpisode = createFeedEpisode('same')
      const libraryItem = createLibraryItem()
      libraryItem.media.podcastEpisodes.push({ guid: feedEpisode.guid, enclosureURL: feedEpisode.enclosure.url })
      const failure = retainFailure('failed-attempt', { libraryItem, feedEpisode })
      stubLibraryItemLookup(libraryItem)

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result).to.deep.equal({ success: false, reason: 'already-downloaded' })
      expect(podcastManager.failedDownloads).to.deep.equal([failure])
    })

    it('keeps the failure and explains when the podcast was removed', async () => {
      const failure = retainFailure()
      stubLibraryItemLookup(null)

      const result = await podcastManager.retryFailedDownload(failure.id, failure.libraryId)

      expect(result).to.deep.equal({ success: false, reason: 'podcast-not-found' })
      expect(podcastManager.failedDownloads).to.deep.equal([failure])
    })

    it('matches an episode by URL when the feed does not provide a GUID', async () => {
      const libraryItem = createLibraryItem()
      const feedEpisode = createFeedEpisode('same-url', { guid: null })
      const failure = retainFailure('failed-attempt', { libraryItem, feedEpisode })
      const activeEpisode = createFeedEpisode('different-feed-entry', {
        guid: null,
        enclosure: { ...feedEpisode.enclosure }
      })
      podcastManager.currentDownload = createEpisodeDownload('active-attempt', { libraryItem, feedEpisode: activeEpisode })
      stubLibraryItemLookup(libraryItem)

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result).to.deep.equal({ success: false, reason: 'already-active' })
      expect(podcastManager.failedDownloads).to.deep.equal([failure])
    })

    it('turns a failed retry into one new failed attempt without retrying automatically', async () => {
      const libraryItem = createLibraryItem()
      const failure = retainFailure('old-attempt', { libraryItem })
      stubLibraryItemLookup(libraryItem)
      const processStub = sinon.stub(podcastManager, 'processPodcastEpisodeDownload').callsFake((download) => {
        download.setFinished(false, 'transfer')
        podcastManager.retainFailedDownload(download)
        podcastManager.currentDownload = null
        return Promise.resolve(false)
      })

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result.success).to.be.true
      expect(processStub.calledOnce).to.be.true
      expect(podcastManager.failedDownloads).to.have.length(1)
      expect(podcastManager.failedDownloads[0].id).to.equal(result.download.id)
      expect(podcastManager.failedDownloads[0].id).to.not.equal(failure.id)
      expect(podcastManager.failedDownloads[0].failureCategory).to.equal('transfer')
      expect(podcastManager.downloadQueue).to.deep.equal([])
    })

    it('leaves no failure behind when the fresh retry attempt succeeds', async () => {
      const libraryItem = createLibraryItem()
      const failure = retainFailure('old-attempt', { libraryItem })
      stubLibraryItemLookup(libraryItem)
      const processStub = sinon.stub(podcastManager, 'processPodcastEpisodeDownload').callsFake((download) => {
        download.setFinished(true)
        podcastManager.currentDownload = null
        return Promise.resolve(true)
      })

      const result = await podcastManager.retryFailedDownload(failure.id, libraryItem.libraryId)

      expect(result.success).to.be.true
      expect(result.download.id).to.not.equal(failure.id)
      expect(processStub.calledOnce).to.be.true
      expect(podcastManager.failedDownloads).to.deep.equal([])
    })
  })

  describe('download failure classification and cleanup', () => {
    function stubDownloadRuntime(ffmpegResponse) {
      sinon.stub(fs, 'pathExists').resolves(true)
      sinon.stub(fs, 'remove').resolves()
      sinon.stub(Watcher, 'addIgnoreDir')
      sinon.stub(Watcher, 'removeIgnoreDir')
      const task = { setFinished: sinon.spy(), setFailed: sinon.spy() }
      sinon.stub(TaskManager, 'createAndAddTask').returns(task)
      sinon.stub(TaskManager, 'taskFinished')
      sinon.stub(ffmpegHelpers, 'downloadPodcastEpisode').resolves(ffmpegResponse)
      return task
    }

    it('records a transfer failure after the request cannot be made', async () => {
      stubDownloadRuntime({ success: false, isRequestError: true })
      const download = createEpisodeDownload('attempt-1')

      const result = podcastManager.startPodcastEpisodeDownload(download)
      const success = await result.completion

      expect(success).to.be.false
      expect(podcastManager.failedDownloads).to.have.length(1)
      expect(podcastManager.failedDownloads[0].failureCategory).to.equal('transfer')
      expect(podcastManager.currentDownload).to.be.null
    })

    it('records probing only after the existing untagged fallback also fails inspection', async () => {
      stubDownloadRuntime({ success: true })
      sinon.stub(podcastManager, 'scanAddPodcastEpisodeAudioFile').resolves({ success: false, failureCategory: 'probing' })
      const fallbackStub = sinon.stub(podcastManager, 'downloadPodcastEpisodeWithoutTagging').resolves()
      const download = createEpisodeDownload('attempt-1')

      const result = podcastManager.startPodcastEpisodeDownload(download)
      await result.completion

      expect(fallbackStub.calledOnce).to.be.true
      expect(podcastManager.scanAddPodcastEpisodeAudioFile.callCount).to.equal(2)
      expect(podcastManager.failedDownloads[0].failureCategory).to.equal('probing')
    })

    it('records persistence without incorrectly running the untagged fallback', async () => {
      stubDownloadRuntime({ success: true })
      sinon.stub(podcastManager, 'scanAddPodcastEpisodeAudioFile').resolves({ success: false, failureCategory: 'persistence' })
      const fallbackStub = sinon.stub(podcastManager, 'downloadPodcastEpisodeWithoutTagging').resolves()
      const download = createEpisodeDownload('attempt-1')

      const result = podcastManager.startPodcastEpisodeDownload(download)
      await result.completion

      expect(fallbackStub.called).to.be.false
      expect(podcastManager.failedDownloads[0].failureCategory).to.equal('persistence')
    })

    it('preserves a successful untagged fallback without creating a failure', async () => {
      stubDownloadRuntime({ success: false })
      sinon.stub(podcastManager, 'downloadPodcastEpisodeWithoutTagging').resolves()
      sinon.stub(podcastManager, 'scanAddPodcastEpisodeAudioFile').resolves({ success: true, failureCategory: null })
      const download = createEpisodeDownload('attempt-1')

      const result = podcastManager.startPodcastEpisodeDownload(download)
      const success = await result.completion

      expect(success).to.be.true
      expect(podcastManager.failedDownloads).to.deep.equal([])
      expect(download.failed).to.be.false
      expect(download.failureCategory).to.be.null
    })

    it('starts the next waiting download after a failure', async () => {
      stubDownloadRuntime({ success: false, isRequestError: true })
      ffmpegHelpers.downloadPodcastEpisode.onSecondCall().returns(new Promise(() => {}))
      const first = createEpisodeDownload('attempt-1')
      const second = createEpisodeDownload('attempt-2')

      const firstResult = podcastManager.startPodcastEpisodeDownload(first)
      const secondResult = podcastManager.startPodcastEpisodeDownload(second)
      await firstResult.completion

      expect(secondResult.state).to.equal('queued')
      expect(podcastManager.currentDownload.id).to.equal(second.id)
      expect(podcastManager.failedDownloads.map((download) => download.id)).to.deep.equal([first.id])
    })
  })
})
