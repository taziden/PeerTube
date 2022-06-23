/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import 'mocha'
import * as chai from 'chai'
import { wait } from '@shared/core-utils'
import { HttpStatusCode, LiveVideoCreate, VideoPrivacy } from '@shared/models'
import {
  cleanupTests,
  createSingleServer,
  makeRawRequest,
  PeerTubeServer,
  setAccessTokensToServers,
  setDefaultVideoChannel,
  stopFfmpeg,
  waitJobs
} from '@shared/server-commands'

const expect = chai.expect

describe('Fast restream in live', function () {
  let server: PeerTubeServer

  async function createLiveWrapper (options: { permanent: boolean, replay: boolean }) {
    const attributes: LiveVideoCreate = {
      channelId: server.store.channel.id,
      privacy: VideoPrivacy.PUBLIC,
      name: 'my super live',
      saveReplay: options.replay,
      permanentLive: options.permanent
    }

    const { uuid } = await server.live.create({ fields: attributes })
    return uuid
  }

  async function fastRestreamWrapper ({ replay }: { replay: boolean }) {
    const liveVideoUUID = await createLiveWrapper({ permanent: true, replay })
    await waitJobs([ server ])

    const rtmpOptions = {
      videoId: liveVideoUUID,
      copyCodecs: true,
      fixtureName: 'video_short.mp4'
    }

    // Streaming session #1
    let ffmpegCommand = await server.live.sendRTMPStreamInVideo(rtmpOptions)
    await server.live.waitUntilPublished({ videoId: liveVideoUUID })
    await stopFfmpeg(ffmpegCommand)
    await server.live.waitUntilWaiting({ videoId: liveVideoUUID })

    // Streaming session #2
    ffmpegCommand = await server.live.sendRTMPStreamInVideo(rtmpOptions)
    await server.live.waitUntilSegmentGeneration({ videoUUID: liveVideoUUID, segment: 0, playlistNumber: 0, totalSessions: 2 })

    return { ffmpegCommand, liveVideoUUID }
  }

  async function ensureLastLiveWorks (liveId: string) {
    // Equivalent to PEERTUBE_TEST_CONSTANTS.VIDEO_LIVE.CLEANUP_DELAY
    for (let i = 0; i < 100; i++) {
      const video = await server.videos.get({ id: liveId })
      expect(video.streamingPlaylists).to.have.lengthOf(1)

      await server.live.getSegment({ videoUUID: liveId, segment: 0, playlistNumber: 0 })
      await makeRawRequest(video.streamingPlaylists[0].playlistUrl, HttpStatusCode.OK_200)

      await wait(100)
    }
  }

  async function runTest (replay: boolean) {
    const { ffmpegCommand, liveVideoUUID } = await fastRestreamWrapper({ replay })

    await ensureLastLiveWorks(liveVideoUUID)

    await stopFfmpeg(ffmpegCommand)
    await server.live.waitUntilWaiting({ videoId: liveVideoUUID })

    // Wait for replays
    await waitJobs([ server ])

    const { total, data: sessions } = await server.live.listSessions({ videoId: liveVideoUUID })

    expect(total).to.equal(2)
    expect(sessions).to.have.lengthOf(2)

    for (const session of sessions) {
      expect(session.error).to.be.null

      if (replay) {
        expect(session.replayVideo).to.exist

        await server.videos.get({ id: session.replayVideo.uuid })
      } else {
        expect(session.replayVideo).to.not.exist
      }
    }
  }

  before(async function () {
    this.timeout(120000)

    const env = { 'PEERTUBE_TEST_CONSTANTS.VIDEO_LIVE.CLEANUP_DELAY': '10000' }
    server = await createSingleServer(1, {}, { env })

    // Get the access tokens
    await setAccessTokensToServers([ server ])
    await setDefaultVideoChannel([ server ])

    await server.config.enableMinimumTranscoding(false, true)
    await server.config.enableLive({ allowReplay: true, transcoding: true, resolutions: 'min' })
  })

  it('Should correctly fast reastream in a permanent live with and without save replay', async function () {
    this.timeout(240000)

    // A test can take a long time, so prefer to run them in parallel
    await Promise.all([
      runTest(true),
      runTest(false)
    ])
  })

  after(async function () {
    await cleanupTests([ server ])
  })
})