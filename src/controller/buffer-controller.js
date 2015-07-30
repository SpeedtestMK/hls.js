/*
 * buffer controller
 *
 */

import Event from '../events';
import observer from '../observer';
import { logger } from '../utils/logger';
import Demuxer from '../demux/demuxer';
import { ErrorTypes, ErrorDetails } from '../errors';

class BufferController {
    constructor(hls) {
        this.ERROR = -2;
        this.STARTING = -1;
        this.IDLE = 0;
        this.LOADING = 1;
        this.WAITING_LEVEL = 2;
        this.PARSING = 3;
        this.PARSED = 4;
        this.APPENDING = 5;
        this.BUFFER_FLUSHING = 6;
        this.config = hls.config;
        this.startPosition = 0;
        this.hls = hls;
        // Source Buffer listeners
        this.onsbue = this.onSourceBufferUpdateEnd.bind(this);
        this.onsbe = this.onSourceBufferError.bind(this);
        // internal listeners
        this.onmse = this.onMSEAttached.bind(this);
        this.onmp = this.onManifestParsed.bind(this);
        this.onll = this.onLevelLoaded.bind(this);
        this.onfl = this.onFragmentLoaded.bind(this);
        this.onis = this.onInitSegment.bind(this);
        this.onfpg = this.onFragmentParsing.bind(this);
        this.onfp = this.onFragmentParsed.bind(this);
        this.onerr = this.onError.bind(this);
        this.ontick = this.tick.bind(this);
        observer.on(Event.MSE_ATTACHED, this.onmse);
        observer.on(Event.MANIFEST_PARSED, this.onmp);
    }
    destroy() {
        this.stop();
        observer.off(Event.MANIFEST_PARSED, this.onmp);
        // remove video listener
        if (this.video) {
            this.video.removeEventListener('seeking', this.onvseeking);
            this.video.removeEventListener('seeked', this.onvseeked);
            this.video.removeEventListener('loadedmetadata', this.onvmetadata);
            this.onvseeking = this.onvseeked = this.onvmetadata = null;
        }
        this.state = this.IDLE;
    }

    startLoad() {
        if (this.levels && this.video) {
            this.startInternal();
            if (this.lastCurrentTime) {
                logger.log(`resuming video @ ${this.lastCurrentTime}`);
                this.startPosition = this.lastCurrentTime;
                this.state = this.IDLE;
            } else {
                this.state = this.STARTING;
            }
            this.tick();
        } else {
            logger.warn(
                `cannot start loading as either manifest not parsed or video not attached`
            );
        }
    }

    startInternal() {
        this.stop();
        this.demuxer = new Demuxer(this.config);
        this.timer = setInterval(this.ontick, 100);
        this.level = -1;
        observer.on(Event.FRAG_LOADED, this.onfl);
        observer.on(Event.FRAG_PARSING_INIT_SEGMENT, this.onis);
        observer.on(Event.FRAG_PARSING_DATA, this.onfpg);
        observer.on(Event.FRAG_PARSED, this.onfp);
        observer.on(Event.ERROR, this.onerr);
        observer.on(Event.LEVEL_LOADED, this.onll);
    }

    stop() {
        this.mp4segments = [];
        this.flushRange = [];
        this.bufferRange = [];
        if (this.frag) {
            if (this.frag.loader) {
                this.frag.loader.abort();
            }
            this.frag = null;
        }
        if (this.sourceBuffer) {
            for (var type in this.sourceBuffer) {
                var sb = this.sourceBuffer[type];
                try {
                    this.mediaSource.removeSourceBuffer(sb);
                    sb.removeEventListener('updateend', this.onsbue);
                    sb.removeEventListener('error', this.onsbe);
                } catch (err) {}
            }
            this.sourceBuffer = null;
        }
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.demuxer) {
            this.demuxer.destroy();
            this.demuxer = null;
        }
        observer.off(Event.FRAG_LOADED, this.onfl);
        observer.off(Event.FRAG_PARSED, this.onfp);
        observer.off(Event.FRAG_PARSING_DATA, this.onfpg);
        observer.off(Event.LEVEL_LOADED, this.onll);
        observer.off(Event.FRAG_PARSING_INIT_SEGMENT, this.onis);
        observer.off(Event.ERROR, this.onerr);
    }

    tick() {
        var pos, level, levelDetails, fragIdx;
        switch (this.state) {
            case this.ERROR:
                //don't do anything in error state to avoid breaking further ...
                break;
            case this.STARTING:
                // determine load level
                this.startLevel = this.hls.startLevel;
                if (this.startLevel === -1) {
                    // -1 : guess start Level by doing a bitrate test by loading first fragment of lowest quality level
                    this.startLevel = 0;
                    this.fragmentBitrateTest = true;
                }
                // set new level to playlist loader : this will trigger start level load
                this.hls.nextLoadLevel = this.startLevel;
                this.state = this.WAITING_LEVEL;
                this.loadedmetadata = false;
                break;
            case this.IDLE:
                // handle end of immediate switching if needed
                if (this.immediateSwitch) {
                    this.immediateLevelSwitchEnd();
                    break;
                }

                // seek back to a expected position after video stalling
                if (this.seekAfterStalling) {
                    this.video.currentTime = this.seekAfterStalling;
                    this.seekAfterStalling = undefined;
                }

                // determine next candidate fragment to be loaded, based on current position and
                //  end of buffer position
                //  ensure 60s of buffer upfront
                // if we have not yet loaded any fragment, start loading from start position
                if (this.loadedmetadata) {
                    pos = this.video.currentTime;
                } else {
                    pos = this.nextLoadPosition;
                }
                // determine next load level
                if (this.startFragmentRequested === false) {
                    level = this.startLevel;
                } else {
                    // we are not at playback start, get next load level from level Controller
                    level = this.hls.nextLoadLevel;
                }
                var bufferInfo = this.bufferInfo(pos),
                    bufferLen = bufferInfo.len,
                    bufferEnd = bufferInfo.end,
                    maxBufLen;
                // compute max Buffer Length that we could get from this load level, based on level bitrate. don't buffer more than 60 MB and more than 30s
                if (this.levels[level].hasOwnProperty('bitrate')) {
                    maxBufLen = Math.max(
                        8 *
                            this.config.maxBufferSize /
                            this.levels[level].bitrate,
                        this.config.maxBufferLength
                    );
                } else {
                    maxBufLen = this.config.maxBufferLength;
                }
                // if buffer length is less than maxBufLen try to load a new fragment
                if (bufferLen < maxBufLen) {
                    // set next load level : this will trigger a playlist load if needed
                    this.hls.nextLoadLevel = level;
                    this.level = level;
                    levelDetails = this.levels[level].details;
                    // if level info not retrieved yet, switch state and wait for level retrieval
                    if (typeof levelDetails === 'undefined') {
                        this.state = this.WAITING_LEVEL;
                        break;
                    }
                    // find fragment index, contiguous with end of buffer position
                    let fragments = levelDetails.fragments,
                        frag,
                        sliding = levelDetails.sliding,
                        start = fragments[0].start + sliding,
                        drift = 0;
                    // check if requested position is within seekable boundaries :
                    // in case of live playlist we need to ensure that requested position is not located before playlist start
                    //logger.log(`start/pos/bufEnd/seeking:${start.toFixed(3)}/${pos.toFixed(3)}/${bufferEnd.toFixed(3)}/${this.video.seeking}`);
                    if (bufferEnd < start) {
                        this.seekAfterStalling = this.startPosition + sliding;
                        logger.log(
                            `buffer end: ${bufferEnd} is located before start of live sliding playlist, media position will be reseted to: ${this.seekAfterStalling.toFixed(
                                3
                            )}`
                        );
                        bufferEnd = this.seekAfterStalling;
                    }

                    if (
                        levelDetails.live &&
                        levelDetails.sliding === undefined
                    ) {
                        /* we are switching level on live playlist, but we don't have any sliding info ...
               try to load frag matching with next SN.
               even if SN are not synchronized between playlists, loading this frag will help us
               compute playlist sliding and find the right one after in case it was not the right consecutive one */
                        if (this.frag) {
                            var targetSN = this.frag.sn + 1;
                            if (
                                targetSN >= levelDetails.startSN &&
                                targetSN <= levelDetails.endSN
                            ) {
                                frag =
                                    fragments[targetSN - levelDetails.startSN];
                                logger.log(
                                    `live playlist, switching playlist, load frag with next SN: ${
                                        frag.sn
                                    }`
                                );
                            }
                        }
                        if (!frag) {
                            /* we have no idea about which fragment should be loaded.
                 so let's load mid fragment. it will help computing playlist sliding and find the right one
              */
                            frag = fragments[Math.round(fragments.length / 2)];
                            logger.log(
                                `live playlist, switching playlist, unknown, load middle frag : ${
                                    frag.sn
                                }`
                            );
                        }
                    } else {
                        //look for fragments matching with current play position
                        for (
                            fragIdx = 0;
                            fragIdx < fragments.length;
                            fragIdx++
                        ) {
                            frag = fragments[fragIdx];
                            start = frag.start + sliding;
                            if (frag.drift) {
                                drift = frag.drift;
                                //logger.log(`level/sn/sliding/start/end/bufEnd:${level}/${frag.sn}/${sliding}/${start.toFixed(3)}/${(start+frag.duration).toFixed(3)}/${bufferEnd.toFixed(3)}`);
                            }
                            start += drift;
                            // offset should be within fragment boundary
                            if (
                                start <= bufferEnd &&
                                start + frag.duration > bufferEnd
                            ) {
                                break;
                            }
                        }
                        if (fragIdx === fragments.length) {
                            // reach end of playlist
                            break;
                        }
                        //logger.log('find SN matching with pos:' +  bufferEnd + ':' + frag.sn);
                        if (this.frag && frag.sn === this.frag.sn) {
                            if (fragIdx === fragments.length - 1) {
                                // we are at the end of the playlist and we already loaded last fragment, don't do anything
                                break;
                            } else {
                                frag = fragments[fragIdx + 1];
                                logger.log(
                                    `SN just loaded, load next one: ${frag.sn}`
                                );
                            }
                        }
                    }
                    logger.log(
                        `Loading       ${frag.sn} of [${
                            levelDetails.startSN
                        } ,${
                            levelDetails.endSN
                        }],level ${level}, bufferEnd:${bufferEnd.toFixed(3)}`
                    );
                    //logger.log('      loading frag ' + i +',pos/bufEnd:' + pos.toFixed(3) + '/' + bufferEnd.toFixed(3));
                    frag.drift = drift;
                    frag.autoLevel = this.hls.autoLevelEnabled;
                    if (this.levels.length > 1) {
                        frag.expectedLen = Math.round(
                            frag.duration * this.levels[level].bitrate / 8
                        );
                        frag.trequest = new Date();
                    }

                    // ensure that we are not reloading the same fragments in loop ...
                    if (this.fragLoadIdx !== undefined) {
                        this.fragLoadIdx++;
                    } else {
                        this.fragLoadIdx = 0;
                    }
                    if (frag.loadCounter) {
                        frag.loadCounter++;
                        let maxThreshold = this.config.fragLoadingLoopThreshold;
                        // if this frag has already been loaded 3 times, and if it has been reloaded recently
                        if (
                            frag.loadCounter > maxThreshold &&
                            Math.abs(this.fragLoadIdx - frag.loadIdx) <
                                maxThreshold
                        ) {
                            observer.trigger(Event.ERROR, {
                                type: ErrorTypes.MEDIA_ERROR,
                                details: ErrorDetails.FRAG_LOOP_LOADING_ERROR,
                                fatal: false,
                                frag: this.frag
                            });
                            return;
                        }
                    } else {
                        frag.loadCounter = 1;
                    }
                    frag.loadIdx = this.fragLoadIdx;
                    this.frag = frag;
                    this.startFragmentRequested = true;
                    observer.trigger(Event.FRAG_LOADING, { frag: frag });
                    this.state = this.LOADING;
                }
                break;
            case this.WAITING_LEVEL:
                level = this.levels[this.level];
                // check if playlist is already loaded
                if (level && level.details) {
                    this.state = this.IDLE;
                }
                break;
            case this.LOADING:
                /*
          monitor fragment retrieval time...
          we compute expected time of arrival of the complete fragment.
          we compare it to expected time of buffer starvation
        */
                let v = this.video,
                    frag = this.frag;
                /* only monitor frag retrieval time if
        (video not paused OR first fragment being loaded) AND autoswitching enabled AND not lowest level AND multiple levels */
                if (
                    v &&
                    (!v.paused || this.loadedmetadata === false) &&
                    frag.autoLevel &&
                    this.level &&
                    this.levels.length > 1
                ) {
                    var requestDelay = new Date() - frag.trequest;
                    // monitor fragment load progress after half of expected fragment duration,to stabilize bitrate
                    if (requestDelay > 500 * frag.duration) {
                        var loadRate = frag.loaded * 1000 / requestDelay; // byte/s
                        if (frag.expectedLen < frag.loaded) {
                            frag.expectedLen = frag.loaded;
                        }
                        pos = v.currentTime;
                        var fragLoadedDelay =
                            (frag.expectedLen - frag.loaded) / loadRate;
                        var bufferStarvationDelay =
                            this.bufferInfo(pos).end - pos;
                        var fragLevelNextLoadedDelay =
                            frag.duration *
                            this.levels[this.hls.nextLoadLevel].bitrate /
                            (8 * loadRate); //bps/Bps
                        /* if we have less than 2 frag duration in buffer and if frag loaded delay is greater than buffer starvation delay
              ... and also bigger than duration needed to load fragment at next level ...*/
                        if (
                            bufferStarvationDelay < 2 * frag.duration &&
                            fragLoadedDelay > bufferStarvationDelay &&
                            fragLoadedDelay > fragLevelNextLoadedDelay
                        ) {
                            // abort fragment loading ...
                            logger.warn(
                                'loading too slow, abort fragment loading'
                            );
                            logger.log(
                                `fragLoadedDelay/bufferStarvationDelay/fragLevelNextLoadedDelay :${fragLoadedDelay.toFixed(
                                    1
                                )}/${bufferStarvationDelay.toFixed(
                                    1
                                )}/${fragLevelNextLoadedDelay.toFixed(1)}`
                            );
                            //abort fragment loading
                            frag.loader.abort();
                            this.frag = null;
                            observer.trigger(
                                Event.FRAG_LOAD_EMERGENCY_ABORTED,
                                { frag: frag }
                            );
                            // switch back to IDLE state to request new fragment at lowest level
                            this.state = this.IDLE;
                        }
                    }
                }
                break;
            case this.PARSING:
                // nothing to do, wait for fragment being parsed
                break;
            case this.PARSED:
            case this.APPENDING:
                if (this.sourceBuffer) {
                    // if MP4 segment appending in progress nothing to do
                    if (
                        (this.sourceBuffer.audio &&
                            this.sourceBuffer.audio.updating) ||
                        (this.sourceBuffer.video &&
                            this.sourceBuffer.video.updating)
                    ) {
                        //logger.log('sb append in progress');
                        // check if any MP4 segments left to append
                    } else if (this.mp4segments.length) {
                        var segment = this.mp4segments.shift();
                        try {
                            //logger.log(`appending ${segment.type} SB, size:${segment.data.length}`);
                            this.sourceBuffer[segment.type].appendBuffer(
                                segment.data
                            );
                            this.appendError = 0;
                        } catch (err) {
                            // in case any error occured while appending, put back segment in mp4segments table
                            logger.error(
                                `error while trying to append buffer:${
                                    err.message
                                },try appending later`
                            );
                            this.mp4segments.unshift(segment);
                            if (this.appendError) {
                                this.appendError++;
                            } else {
                                this.appendError = 1;
                            }
                            var event = {
                                type: ErrorTypes.MEDIA_ERROR,
                                details: ErrorDetails.FRAG_APPENDING_ERROR,
                                frag: this.frag
                            };
                            /* with UHD content, we could get loop of quota exceeded error until
                browser is able to evict some data from sourcebuffer. retrying help recovering this
              */
                            if (
                                this.appendError >
                                this.config.appendErrorMaxRetry
                            ) {
                                logger.log(
                                    `fail ${
                                        this.config.appendErrorMaxRetry
                                    } times to append segment in sourceBuffer`
                                );
                                event.fatal = true;
                                observer.trigger(Event.ERROR, event);
                                this.state = this.ERROR;
                                return;
                            } else {
                                event.fatal = false;
                                observer.trigger(Event.ERROR, event);
                            }
                        }
                        this.state = this.APPENDING;
                    }
                }
                break;
            case this.BUFFER_FLUSHING:
                // loop through all buffer ranges to flush
                while (this.flushRange.length) {
                    var range = this.flushRange[0];
                    // flushBuffer will abort any buffer append in progress and flush Audio/Video Buffer
                    if (this.flushBuffer(range.start, range.end)) {
                        // range flushed, remove from flush array
                        this.flushRange.shift();
                    } else {
                        // flush in progress, come back later
                        break;
                    }
                }

                if (this.flushRange.length === 0) {
                    // move to IDLE once flush complete. this should trigger new fragment loading
                    this.state = this.IDLE;
                    // reset reference to frag
                    this.frag = null;
                }
                /* if not everything flushed, stay in BUFFER_FLUSHING state. we will come back here
            each time sourceBuffer updateend() callback will be triggered
            */
                break;
            default:
                break;
        }
        // check/update current fragment
        this._checkFragmentChanged();
    }

    bufferInfo(pos) {
        var v = this.video,
            buffered = v.buffered,
            bufferLen,
            // bufferStart and bufferEnd are buffer boundaries around current video position
            bufferStart,
            bufferEnd,
            i;
        var buffered2 = [];
        // there might be some small holes between buffer time range
        // consider that holes smaller than 300 ms are irrelevant and build another
        // buffer time range representations that discards those holes
        for (i = 0; i < buffered.length; i++) {
            //logger.log('buf start/end:' + buffered.start(i) + '/' + buffered.end(i));
            if (
                buffered2.length &&
                buffered.start(i) - buffered2[buffered2.length - 1].end < 0.3
            ) {
                buffered2[buffered2.length - 1].end = buffered.end(i);
            } else {
                buffered2.push({
                    start: buffered.start(i),
                    end: buffered.end(i)
                });
            }
        }

        for (
            i = 0, bufferLen = 0, bufferStart = bufferEnd = pos;
            i < buffered2.length;
            i++
        ) {
            //logger.log('buf start/end:' + buffered.start(i) + '/' + buffered.end(i));
            if (pos + 0.3 >= buffered2[i].start && pos < buffered2[i].end) {
                // play position is inside this buffer TimeRange, retrieve end of buffer position and buffer length
                bufferStart = buffered2[i].start;
                bufferEnd = buffered2[i].end + 0.3;
                bufferLen = bufferEnd - pos;
            }
        }
        return { len: bufferLen, start: bufferStart, end: bufferEnd };
    }

    getBufferRange(position) {
        var i, range;
        for (i = this.bufferRange.length - 1; i >= 0; i--) {
            range = this.bufferRange[i];
            if (position >= range.start && position <= range.end) {
                return range;
            }
        }
        return null;
    }

    get currentLevel() {
        if (this.video) {
            var range = this.getBufferRange(this.video.currentTime);
            if (range) {
                return range.frag.level;
            }
        }
        return -1;
    }

    get nextBufferRange() {
        if (this.video) {
            // first get end range of current fragment
            return this.followingBufferRange(
                this.getBufferRange(this.video.currentTime)
            );
        } else {
            return null;
        }
    }

    followingBufferRange(range) {
        if (range) {
            // try to get range of next fragment (500ms after this range)
            return this.getBufferRange(range.end + 0.5);
        }
        return null;
    }

    get nextLevel() {
        var range = this.nextBufferRange;
        if (range) {
            return range.frag.level;
        } else {
            return -1;
        }
    }

    isBuffered(position) {
        var v = this.video,
            buffered = v.buffered;
        for (var i = 0; i < buffered.length; i++) {
            if (position >= buffered.start(i) && position <= buffered.end(i)) {
                return true;
            }
        }
        return false;
    }

    _checkFragmentChanged() {
        var rangeCurrent, currentTime;
        if (this.video && this.video.seeking === false) {
            this.lastCurrentTime = currentTime = this.video.currentTime;
            if (this.isBuffered(currentTime)) {
                rangeCurrent = this.getBufferRange(currentTime);
            } else if (this.isBuffered(currentTime + 0.1)) {
                /* ensure that FRAG_CHANGED event is triggered at startup,
          when first video frame is displayed and playback is paused.
          add a tolerance of 100ms, in case current position is not buffered,
          check if current pos+100ms is buffered and use that buffer range
          for FRAG_CHANGED event reporting */
                rangeCurrent = this.getBufferRange(currentTime + 0.1);
            }
            if (rangeCurrent) {
                if (rangeCurrent.frag !== this.fragCurrent) {
                    this.fragCurrent = rangeCurrent.frag;
                    observer.trigger(Event.FRAG_CHANGED, {
                        frag: this.fragCurrent
                    });
                }
                // if stream is VOD (not live) and we reach End of Stream
                var level = this.levels[this.level];
                if (
                    level &&
                    level.details &&
                    !level.details.live &&
                    this.video.duration - currentTime < 0.2
                ) {
                    if (
                        this.mediaSource &&
                        this.mediaSource.readyState === 'open'
                    ) {
                        logger.log(
                            `end of VoD stream reached, signal endOfStream() to MediaSource`
                        );
                        this.mediaSource.endOfStream();
                    }
                }
            }
        }
    }

    /*
  abort any buffer append in progress, and flush all buffered data
  return true once everything has been flushed.
  sourceBuffer.abort() and sourceBuffer.remove() are asynchronous operations
  the idea is to call this function from tick() timer and call it again until all resources have been cleaned
  the timer is rearmed upon sourceBuffer updateend() event, so this should be optimal
*/
    flushBuffer(startOffset, endOffset) {
        var sb, i, bufStart, bufEnd, flushStart, flushEnd;
        //logger.log('flushBuffer,pos/start/end: ' + this.video.currentTime + '/' + startOffset + '/' + endOffset);
        // safeguard to avoid infinite looping
        if (
            this.flushBufferCounter++ < 2 * this.bufferRange.length &&
            this.sourceBuffer
        ) {
            for (var type in this.sourceBuffer) {
                sb = this.sourceBuffer[type];
                if (!sb.updating) {
                    for (i = 0; i < sb.buffered.length; i++) {
                        bufStart = sb.buffered.start(i);
                        bufEnd = sb.buffered.end(i);
                        // workaround firefox not able to properly flush multiple buffered range.
                        if (
                            navigator.userAgent
                                .toLowerCase()
                                .indexOf('firefox') !== -1 &&
                            endOffset === Number.POSITIVE_INFINITY
                        ) {
                            flushStart = startOffset;
                            flushEnd = endOffset;
                        } else {
                            flushStart = Math.max(bufStart, startOffset);
                            flushEnd = Math.min(bufEnd, endOffset);
                        }
                        /* sometimes sourcebuffer.remove() does not flush
               the exact expected time range.
               to avoid rounding issues/infinite loop,
               only flush buffer range of length greater than 500ms.
            */
                        if (flushEnd - flushStart > 0.5) {
                            logger.log(
                                `flush ${type} [${flushStart},${flushEnd}], of [${bufStart},${bufEnd}], pos:${
                                    this.video.currentTime
                                }`
                            );
                            sb.remove(flushStart, flushEnd);
                            return false;
                        }
                    }
                } else {
                    //logger.log('abort ' + type + ' append in progress');
                    // this will abort any appending in progress
                    //sb.abort();
                    return false;
                }
            }
        }

        /* after successful buffer flushing, rebuild buffer Range array
      loop through existing buffer range and check if
      corresponding range is still buffered. only push to new array already buffered range
    */
        var newRange = [],
            range;
        for (i = 0; i < this.bufferRange.length; i++) {
            range = this.bufferRange[i];
            if (this.isBuffered((range.start + range.end) / 2)) {
                newRange.push(range);
            }
        }
        this.bufferRange = newRange;

        logger.log('buffer flushed');
        // everything flushed !
        return true;
    }

    /*
      on immediate level switch :
       - pause playback if playing
       - cancel any pending load request
       - and trigger a buffer flush
    */
    immediateLevelSwitch() {
        logger.log('immediateLevelSwitch');
        if (!this.immediateSwitch) {
            this.immediateSwitch = true;
            this.previouslyPaused = this.video.paused;
            this.video.pause();
        }
        if (this.frag && this.frag.loader) {
            this.frag.loader.abort();
        }
        this.frag = null;
        // flush everything
        this.flushBufferCounter = 0;
        this.flushRange.push({ start: 0, end: Number.POSITIVE_INFINITY });
        // trigger a sourceBuffer flush
        this.state = this.BUFFER_FLUSHING;
        // increase fragment load Index to avoid frag loop loading error after buffer flush
        this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
        // speed up switching, trigger timer function
        this.tick();
    }

    /*
   on immediate level switch end, after new fragment has been buffered :
    - nudge video decoder by slightly adjusting video currentTime
    - resume the playback if needed
*/
    immediateLevelSwitchEnd() {
        this.immediateSwitch = false;
        this.video.currentTime -= 0.0001;
        if (!this.previouslyPaused) {
            this.video.play();
        }
    }

    nextLevelSwitch() {
        /* try to switch ASAP without breaking video playback :
       in order to ensure smooth but quick level switching,
      we need to find the next flushable buffer range
      we should take into account new segment fetch time
    */
        var fetchdelay, currentRange, nextRange;

        currentRange = this.getBufferRange(this.video.currentTime);
        if (currentRange) {
            // flush buffer preceding current fragment (flush until current fragment start offset)
            // minus 1s to avoid video freezing, that could happen if we flush keyframe of current video ...
            this.flushRange.push({ start: 0, end: currentRange.start - 1 });
        }

        if (!this.video.paused) {
            // add a safety delay of 1s
            var nextLevelId = this.hls.nextLoadLevel,
                nextLevel = this.levels[nextLevelId];
            if (this.hls.stats.fragLastKbps && this.frag) {
                fetchdelay =
                    this.frag.duration *
                        nextLevel.bitrate /
                        (1000 * this.hls.stats.fragLastKbps) +
                    1;
            } else {
                fetchdelay = 0;
            }
        } else {
            fetchdelay = 0;
        }
        //logger.log('fetchdelay:'+fetchdelay);
        // find buffer range that will be reached once new fragment will be fetched
        nextRange = this.getBufferRange(this.video.currentTime + fetchdelay);
        if (nextRange) {
            // we can flush buffer range following this one without stalling playback
            nextRange = this.followingBufferRange(nextRange);
            if (nextRange) {
                // flush position is the start position of this new buffer
                this.flushRange.push({
                    start: nextRange.start,
                    end: Number.POSITIVE_INFINITY
                });
            }
        }
        if (this.flushRange.length) {
            this.flushBufferCounter = 0;
            // trigger a sourceBuffer flush
            this.state = this.BUFFER_FLUSHING;
            // increase fragment load Index to avoid frag loop loading error after buffer flush
            this.fragLoadIdx += 2 * this.config.fragLoadingLoopThreshold;
            // speed up switching, trigger timer function
            this.tick();
        }
    }

    onMSEAttached(event, data) {
        this.video = data.video;
        this.mediaSource = data.mediaSource;
        this.onvseeking = this.onVideoSeeking.bind(this);
        this.onvseeked = this.onVideoSeeked.bind(this);
        this.onvmetadata = this.onVideoMetadata.bind(this);
        this.video.addEventListener('seeking', this.onvseeking);
        this.video.addEventListener('seeked', this.onvseeked);
        this.video.addEventListener('loadedmetadata', this.onvmetadata);
        if (this.levels && this.config.autoStartLoad) {
            this.startLoad();
        }
    }
    onVideoSeeking() {
        if (this.state === this.LOADING) {
            // check if currently loaded fragment is inside buffer.
            //if outside, cancel fragment loading, otherwise do nothing
            if (this.bufferInfo(this.video.currentTime).len === 0) {
                logger.log(
                    'seeking outside of buffer while fragment load in progress, cancel fragment load'
                );
                this.frag.loader.abort();
                this.frag = null;
                // switch to IDLE state to load new fragment
                this.state = this.IDLE;
            }
        }
        if (this.video) {
            this.lastCurrentTime = this.video.currentTime;
        }
        // tick to speed up processing
        this.tick();
    }

    onVideoSeeked() {
        // tick to speed up FRAGMENT_PLAYING triggering
        this.tick();
    }

    onVideoMetadata() {
        if (this.video.currentTime !== this.startPosition) {
            this.video.currentTime = this.startPosition;
        }
        this.loadedmetadata = true;
        this.tick();
    }

    onManifestParsed(event, data) {
        var aac = false,
            heaac = false,
            codecs;
        data.levels.forEach(level => {
            // detect if we have different kind of audio codecs used amongst playlists
            codecs = level.codecs;
            if (codecs) {
                if (codecs.indexOf('mp4a.40.2') !== -1) {
                    aac = true;
                }
                if (codecs.indexOf('mp4a.40.5') !== -1) {
                    heaac = true;
                }
            }
        });
        this.audiocodecswitch = aac && heaac;
        if (this.audiocodecswitch) {
            logger.log(
                'both AAC/HE-AAC audio found in levels; declaring audio codec as HE-AAC'
            );
        }
        this.levels = data.levels;
        this.startLevelLoaded = false;
        this.startFragmentRequested = false;
        if (this.video && this.config.autoStartLoad) {
            this.startLoad();
        }
    }

    onLevelLoaded(event, data) {
        var newLevelDetails = data.details,
            duration = newLevelDetails.totalduration,
            newLevelId = data.level,
            newLevel = this.levels[newLevelId],
            curLevel = this.levels[this.level],
            sliding = 0;
        logger.log(
            `level ${newLevelId} loaded [${newLevelDetails.startSN},${
                newLevelDetails.endSN
            }],duration:${duration}`
        );
        // check if playlist is already loaded (if yes, it should be a live playlist)
        if (curLevel && curLevel.details && curLevel.details.live) {
            var curLevelDetails = curLevel.details;
            //  playlist sliding is the sum of : current playlist sliding + sliding of new playlist compared to current one
            // check sliding of updated playlist against current one :
            // and find its position in current playlist
            //logger.log("fragments[0].sn/this.level/curLevel.details.fragments[0].sn:" + fragments[0].sn + "/" + this.level + "/" + curLevel.details.fragments[0].sn);
            var SNdiff = newLevelDetails.startSN - curLevelDetails.startSN;
            if (SNdiff >= 0) {
                // positive sliding : new playlist sliding window is after previous one
                var oldfragments = curLevelDetails.fragments;
                if (SNdiff < oldfragments.length) {
                    sliding =
                        curLevelDetails.sliding + oldfragments[SNdiff].start;
                } else {
                    logger.log(
                        `cannot compute sliding, no SN in common between old/new level:[${
                            curLevelDetails.startSN
                        },${curLevelDetails.endSN}]/[${
                            newLevelDetails.startSN
                        },${newLevelDetails.endSN}]`
                    );
                    sliding = undefined;
                }
            } else {
                // negative sliding: new playlist sliding window is before previous one
                sliding =
                    curLevelDetails.sliding -
                    newLevelDetails.fragments[-SNdiff].start;
            }
            if (sliding) {
                logger.log(`live playlist sliding:${sliding.toFixed(3)}`);
            }
        }
        // override level info
        newLevel.details = newLevelDetails;
        newLevel.details.sliding = sliding;
        if (this.startLevelLoaded === false) {
            // if live playlist, set start position to be fragment N-3
            if (newLevelDetails.live) {
                this.startPosition = Math.max(
                    0,
                    duration - 3 * newLevelDetails.targetduration
                );
            }
            this.nextLoadPosition = this.startPosition;
            this.startLevelLoaded = true;
        }
        // only switch batck to IDLE state if we were waiting for level to start downloading a new fragment
        if (this.state === this.WAITING_LEVEL) {
            this.state = this.IDLE;
        }
        //trigger handler right now
        this.tick();
    }

    onFragmentLoaded(event, data) {
        if (this.state === this.LOADING) {
            if (this.fragmentBitrateTest === true) {
                // switch back to IDLE state ... we just loaded a fragment to determine adequate start bitrate and initialize autoswitch algo
                this.state = this.IDLE;
                this.fragmentBitrateTest = false;
                data.stats.tparsed = data.stats.tbuffered = new Date();
                observer.trigger(Event.FRAG_BUFFERED, {
                    stats: data.stats,
                    frag: this.frag
                });
                this.frag = null;
            } else {
                this.state = this.PARSING;
                // transmux the MPEG-TS data to ISO-BMFF segments
                this.stats = data.stats;
                var currentLevel = this.levels[this.level],
                    details = currentLevel.details,
                    duration = details.totalduration,
                    start = this.frag.start;
                if (details.live) {
                    duration += details.sliding;
                    start += details.sliding;
                }
                if (this.frag.drift) {
                    start += this.frag.drift;
                }
                logger.log(
                    `Demuxing      ${this.frag.sn} of [${details.startSN} ,${
                        details.endSN
                    }],level ${this.level}`
                );
                this.demuxer.push(
                    data.payload,
                    currentLevel.audioCodec,
                    currentLevel.videoCodec,
                    start,
                    this.frag.cc,
                    this.level,
                    duration
                );
            }
        }
    }

    onInitSegment(event, data) {
        // check if codecs have been explicitely defined in the master playlist for this level;
        // if yes use these ones instead of the ones parsed from the demux
        var audioCodec = this.levels[this.level].audioCodec,
            videoCodec = this.levels[this.level].videoCodec,
            sb;
        //logger.log('playlist level A/V codecs:' + audioCodec + ',' + videoCodec);
        //logger.log('playlist codecs:' + codec);
        // if playlist does not specify codecs, use codecs found while parsing fragment
        if (audioCodec === undefined || data.audiocodec === undefined) {
            audioCodec = data.audioCodec;
        }
        if (videoCodec === undefined || data.videocodec === undefined) {
            videoCodec = data.videoCodec;
        }

        // codec="mp4a.40.5,avc1.420016";
        // in case several audio codecs might be used, force HE-AAC for audio (some browsers don't support audio codec switch)
        //don't do it for mono streams ...
        if (
            this.audiocodecswitch &&
            data.audioChannelCount === 2 &&
            navigator.userAgent.toLowerCase().indexOf('android') === -1 &&
            navigator.userAgent.toLowerCase().indexOf('firefox') === -1
        ) {
            audioCodec = 'mp4a.40.5';
        }
        if (!this.sourceBuffer) {
            this.sourceBuffer = {};
            logger.log(
                `selected A/V codecs for sourceBuffers:${audioCodec},${videoCodec}`
            );
            // create source Buffer and link them to MediaSource
            if (audioCodec) {
                sb = this.sourceBuffer.audio = this.mediaSource.addSourceBuffer(
                    `video/mp4;codecs=${audioCodec}`
                );
                sb.addEventListener('updateend', this.onsbue);
                sb.addEventListener('error', this.onsbe);
            }
            if (videoCodec) {
                sb = this.sourceBuffer.video = this.mediaSource.addSourceBuffer(
                    `video/mp4;codecs=${videoCodec}`
                );
                sb.addEventListener('updateend', this.onsbue);
                sb.addEventListener('error', this.onsbe);
            }
        }
        if (audioCodec) {
            this.mp4segments.push({ type: 'audio', data: data.audioMoov });
        }
        if (videoCodec) {
            this.mp4segments.push({ type: 'video', data: data.videoMoov });
        }
        //trigger handler right now
        this.tick();
    }

    onFragmentParsing(event, data) {
        if (this.state === this.PARSING) {
            this.tparse2 = Date.now();
            var level = this.levels[this.level];
            if (level.details.live) {
                var fragments = this.levels[this.level].details.fragments;
                var sn0 = fragments[0].sn,
                    sn1 = fragments[fragments.length - 1].sn,
                    sn = this.frag.sn;
                //retrieve this.frag.sn in this.levels[this.level]
                if (sn >= sn0 && sn <= sn1) {
                    level.details.sliding =
                        data.startPTS - fragments[sn - sn0].start;
                    //logger.log(`live playlist sliding:${level.details.sliding.toFixed(3)}`);
                }
            }
            logger.log(
                `      parsed data, type/startPTS/endPTS/startDTS/endDTS/nb:${
                    data.type
                }/${data.startPTS.toFixed(3)}/${data.endPTS.toFixed(
                    3
                )}/${data.startDTS.toFixed(3)}/${data.endDTS.toFixed(3)}/${
                    data.nb
                }`
            );
            this.frag.drift = data.startPTS - this.frag.start;
            //logger.log(`      drift:${this.frag.drift.toFixed(3)}`);
            this.mp4segments.push({ type: data.type, data: data.moof });
            this.mp4segments.push({ type: data.type, data: data.mdat });
            this.nextLoadPosition = data.endPTS;
            this.bufferRange.push({
                type: data.type,
                start: data.startPTS,
                end: data.endPTS,
                frag: this.frag
            });
            // if(data.type === 'video') {
            //   this.frag.fpsExpected = (data.nb-1) / (data.endPTS - data.startPTS);
            // }
            //trigger handler right now
            this.tick();
        } else {
            logger.warn(`not in PARSING state, discarding ${event}`);
        }
    }

    onFragmentParsed() {
        if (this.state === this.PARSING) {
            this.state = this.PARSED;
            this.stats.tparsed = new Date();
            //trigger handler right now
            this.tick();
        }
    }

    onError(event, data) {
        switch (data.details) {
            // abort fragment loading on errors
            case ErrorDetails.FRAG_LOAD_ERROR:
            case ErrorDetails.FRAG_LOAD_TIMEOUT:
            case ErrorDetails.FRAG_LOOP_LOADING_ERROR:
            case ErrorDetails.LEVEL_LOAD_ERROR:
            case ErrorDetails.LEVEL_LOAD_TIMEOUT:
                // if fatal error, stop processing, otherwise move to IDLE to retry loading
                logger.warn(
                    `buffer controller: ${
                        data.details
                    } while loading frag,switch to ${
                        data.fatal ? 'ERROR' : 'IDLE'
                    } state ...`
                );
                this.state = data.fatal ? this.ERROR : this.IDLE;
                this.frag = null;
                break;
            default:
                break;
        }
    }

    onSourceBufferUpdateEnd() {
        //trigger handler right now
        if (this.state === this.APPENDING && this.mp4segments.length === 0) {
            if (this.frag) {
                this.stats.tbuffered = new Date();
                observer.trigger(Event.FRAG_BUFFERED, {
                    stats: this.stats,
                    frag: this.frag
                });
                this.state = this.IDLE;
            }
        }
        this.tick();
    }

    onSourceBufferError(event) {
        logger.error(`sourceBuffer error:${event}`);
        this.state = this.ERROR;
        observer.trigger(Event.ERROR, {
            type: ErrorTypes.MEDIA_ERROR,
            details: ErrorDetails.FRAG_APPENDING_ERROR,
            fatal: true,
            frag: this.frag
        });
    }
}

export default BufferController;
