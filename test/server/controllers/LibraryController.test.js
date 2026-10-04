const { expect } = require('chai')
const { Sequelize } = require('sequelize')
const sinon = require('sinon')

const Database = require('../../../server/Database')
const LibraryController = require('../../../server/controllers/LibraryController')
const zipHelpers = require('../../../server/utils/zipHelpers')
const Logger = require('../../../server/Logger')

describe('LibraryController.downloadMultiple', () => {
  let library
  let libraryFolder
  let allowedItemId
  let explicitItemId
  let taggedItemId
  let restrictedUser
  let libraryRecord

  beforeEach(async () => {
    global.ServerSettings = {}
    Database.sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false })
    Database.sequelize.uppercaseFirst = (str) => (str ? `${str[0].toUpperCase()}${str.substr(1)}` : '')
    await Database.buildModels()

    library = await Database.libraryModel.create({ name: 'Test Library', mediaType: 'book' })
    libraryFolder = await Database.libraryFolderModel.create({ path: '/test-lib', libraryId: library.id })
    libraryRecord = await Database.libraryModel.findByIdWithFolders(library.id)

    const allowedBook = await Database.bookModel.create({
      title: 'Allowed Book',
      explicit: false,
      audioFiles: [],
      tags: ['allowed-tag'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const allowedItem = await Database.libraryItemModel.create({
      path: '/test-lib/allowed',
      isFile: false,
      libraryFiles: [],
      mediaId: allowedBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    allowedItemId = allowedItem.id

    const explicitBook = await Database.bookModel.create({
      title: 'Explicit Book',
      explicit: true,
      audioFiles: [],
      tags: [],
      narrators: [],
      genres: [],
      chapters: []
    })
    const explicitItem = await Database.libraryItemModel.create({
      path: '/test-lib/explicit',
      isFile: false,
      libraryFiles: [],
      mediaId: explicitBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    explicitItemId = explicitItem.id

    const taggedBook = await Database.bookModel.create({
      title: 'Tagged Book',
      explicit: false,
      audioFiles: [],
      tags: ['restricted-tag'],
      narrators: [],
      genres: [],
      chapters: []
    })
    const taggedItem = await Database.libraryItemModel.create({
      path: '/test-lib/tagged',
      isFile: false,
      libraryFiles: [],
      mediaId: taggedBook.id,
      mediaType: 'book',
      libraryId: library.id,
      libraryFolderId: libraryFolder.id
    })
    taggedItemId = taggedItem.id

    const permissions = Database.userModel.getDefaultPermissionsForUserType('user')
    permissions.download = true
    permissions.accessExplicitContent = false
    permissions.accessAllLibraries = false
    permissions.accessAllTags = false
    permissions.librariesAccessible = [library.id]
    permissions.itemTagsSelected = ['allowed-tag']
    permissions.selectedTagsNotAccessible = false

    restrictedUser = await Database.userModel.create({
      username: 'restricted',
      pash: 'hash',
      token: 'token',
      type: 'user',
      isActive: true,
      permissions,
      bookmarks: [],
      extraData: {}
    })

    sinon.stub(Logger, 'info')
    sinon.stub(Logger, 'warn')
    sinon.stub(Logger, 'error')
    sinon.stub(zipHelpers, 'zipDirectoriesPipe').resolves()
  })

  afterEach(async () => {
    sinon.restore()
    await Database.sequelize.sync({ force: true })
  })

  function makeReq(ids) {
    return {
      query: { ids: ids.join(',') },
      user: restrictedUser,
      library: libraryRecord
    }
  }

  function makeRes() {
    return {
      sendStatus: sinon.spy(),
      status: sinon.stub().returnsThis(),
      send: sinon.spy()
    }
  }

  it('returns 403 for bulk download of an explicit item', async () => {
    const req = makeReq([explicitItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('returns 403 for bulk download of a tag-restricted item', async () => {
    const req = makeReq([taggedItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('returns 403 when bulk download includes both allowed and forbidden items', async () => {
    const req = makeReq([allowedItemId, explicitItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.calledWith(403)).to.be.true
    expect(zipHelpers.zipDirectoriesPipe.called).to.be.false
  })

  it('starts zip download for allowed items only', async () => {
    const req = makeReq([allowedItemId])
    const res = makeRes()

    await LibraryController.downloadMultiple(req, res)

    expect(res.sendStatus.called).to.be.false
    expect(zipHelpers.zipDirectoriesPipe.calledOnce).to.be.true
    const pathObjects = zipHelpers.zipDirectoriesPipe.firstCall.args[0]
    expect(pathObjects).to.have.length(1)
    expect(pathObjects[0].path).to.equal('/test-lib/allowed')
  })
})

describe('LibraryController failed podcast downloads', () => {
  function makeReq(overrides = {}) {
    return {
      params: { failedDownloadId: 'failure-1' },
      user: { username: 'admin', isAdminOrUp: true },
      library: { id: 'lib-1' },
      ...overrides
    }
  }

  function makeRes() {
    return {
      json: sinon.spy(),
      sendStatus: sinon.spy(),
      status: sinon.stub().returnsThis()
    }
  }

  afterEach(() => {
    sinon.restore()
  })

  it('returns the accepted retry to an administrator', async () => {
    const podcastManager = {
      retryFailedDownload: sinon.stub().resolves({ success: true, download: { id: 'new-attempt' } })
    }
    const req = makeReq()
    const res = makeRes()

    await LibraryController.retryFailedEpisodeDownload.call({ podcastManager }, req, res)

    expect(podcastManager.retryFailedDownload.calledOnceWith('failure-1', 'lib-1')).to.be.true
    expect(res.json.calledOnceWith({ success: true, download: { id: 'new-attempt' } })).to.be.true
  })

  it('returns a specific conflict when the episode is already queued', async () => {
    const podcastManager = {
      retryFailedDownload: sinon.stub().resolves({ success: false, reason: 'already-queued' })
    }
    const req = makeReq()
    const res = makeRes()

    await LibraryController.retryFailedEpisodeDownload.call({ podcastManager }, req, res)

    expect(res.status.calledOnceWith(409)).to.be.true
    expect(res.json.firstCall.args[0]).to.deep.equal({
      error: 'already-queued',
      message: 'This episode is already in the download queue'
    })
  })

  it('does not let a non-admin retry or dismiss failures', async () => {
    const podcastManager = {
      retryFailedDownload: sinon.stub(),
      dismissFailedDownload: sinon.stub()
    }
    const req = makeReq({ user: { username: 'listener', isAdminOrUp: false } })
    const retryRes = makeRes()
    const dismissRes = makeRes()

    await LibraryController.retryFailedEpisodeDownload.call({ podcastManager }, req, retryRes)
    LibraryController.dismissFailedEpisodeDownload.call({ podcastManager }, req, dismissRes)

    expect(retryRes.sendStatus.calledOnceWith(403)).to.be.true
    expect(dismissRes.sendStatus.calledOnceWith(403)).to.be.true
    expect(podcastManager.retryFailedDownload.called).to.be.false
    expect(podcastManager.dismissFailedDownload.called).to.be.false
  })

  it('dismisses an existing failure and returns 404 after it is gone', () => {
    const podcastManager = {
      dismissFailedDownload: sinon.stub()
    }
    podcastManager.dismissFailedDownload.onFirstCall().returns(true)
    podcastManager.dismissFailedDownload.onSecondCall().returns(false)
    const req = makeReq()
    const firstRes = makeRes()
    const secondRes = makeRes()

    LibraryController.dismissFailedEpisodeDownload.call({ podcastManager }, req, firstRes)
    LibraryController.dismissFailedEpisodeDownload.call({ podcastManager }, req, secondRes)

    expect(firstRes.sendStatus.calledOnceWith(200)).to.be.true
    expect(secondRes.sendStatus.calledOnceWith(404)).to.be.true
  })
})
