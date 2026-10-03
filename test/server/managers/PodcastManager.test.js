const { expect } = require('chai')
const sinon = require('sinon')
const SocketAuthority = require('../../../server/SocketAuthority')
const PodcastManager = require('../../../server/managers/PodcastManager')

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

  beforeEach(() => {
    podcastManager = new PodcastManager()
    emitterStub = sinon.stub(SocketAuthority, 'emitter')
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
})
