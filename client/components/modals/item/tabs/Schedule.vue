<template>
  <div class="w-full h-full relative">
    <div id="scheduleWrapper" class="w-full overflow-y-auto px-2 py-4 md:px-6 md:py-6">
      <template v-if="!feedUrl">
        <widgets-alert type="warning" class="text-base mb-4">{{ $strings.ToastPodcastNoRssFeed }}</widgets-alert>
      </template>
      <template v-if="feedUrl || autoDownloadEpisodes">
        <div class="flex items-center justify-between mb-4">
          <p class="text-base md:text-xl font-semibold">{{ $strings.HeaderScheduleEpisodeDownloads }}</p>
          <ui-checkbox v-model="enableAutoDownloadEpisodes" :label="$strings.LabelEnable" medium checkbox-bg="bg" label-class="pl-2 text-base md:text-lg" />
        </div>

        <div v-if="enableAutoDownloadEpisodes" class="flex items-center py-2">
          <ui-text-input ref="maxEpisodesInput" type="number" v-model="newMaxEpisodesToKeep" no-spinner :padding-x="1" text-center class="w-10 text-base" @change="updatedMaxEpisodesToKeep" />
          <ui-tooltip :text="$strings.LabelMaxEpisodesToKeepHelp">
            <p class="pl-4 text-base">
              {{ $strings.LabelMaxEpisodesToKeep }}
              <span class="material-symbols icon-text">info</span>
            </p>
          </ui-tooltip>
        </div>
        <div v-if="enableAutoDownloadEpisodes" class="flex items-center py-2">
          <ui-text-input ref="maxEpisodesToDownloadInput" type="number" v-model="newMaxNewEpisodesToDownload" no-spinner :padding-x="1" text-center class="w-10 text-base" @change="updateMaxNewEpisodesToDownload" />
          <ui-tooltip :text="$strings.LabelUseZeroForUnlimited">
            <p class="pl-4 text-base">
              {{ $strings.LabelMaxEpisodesToDownloadPerCheck }}
              <span class="material-symbols icon-text">info</span>
            </p>
          </ui-tooltip>
        </div>

        <div v-if="enableAutoDownloadEpisodes" class="mt-4 pt-4 border-t border-white/10">
          <p class="text-base font-semibold mb-3">{{ $strings.HeaderAutomaticDownloadFilters }}</p>
          <div class="flex flex-col gap-3">
            <ui-checkbox cy-id="excludeTrailers" v-model="newExcludeTrailers" :label="$strings.LabelExcludeTrailers" medium checkbox-bg="bg" @input="clearPreview" />
            <ui-checkbox cy-id="excludeBonusEpisodes" v-model="newExcludeBonusEpisodes" :label="$strings.LabelExcludeBonusEpisodes" medium checkbox-bg="bg" @input="clearPreview" />
            <ui-text-input-with-label cy-id="excludeTitlePhrase" v-model="newExcludeTitlePhrase" :label="$strings.LabelExcludedTitlePhrase" :placeholder="$strings.PlaceholderExcludedTitlePhrase" trim-whitespace @input="clearPreview" />
          </div>
        </div>

        <widgets-cron-expression-builder ref="cronExpressionBuilder" v-if="enableAutoDownloadEpisodes" v-model="cronExpression" />

        <div v-if="enableAutoDownloadEpisodes && feedUrl" class="mt-5 pt-4 border-t border-white/10">
          <div class="flex items-center justify-between gap-4 mb-3">
            <div>
              <p class="text-base font-semibold">{{ $strings.HeaderAutomaticDownloadPreview }}</p>
              <p class="text-xs text-gray-400">{{ $strings.MessageAutomaticDownloadPreviewHelp }}</p>
            </div>
            <ui-btn cy-id="previewAutomaticDownloads" small :loading="previewLoading" :disabled="previewLoading" @click="loadPreview">{{ $strings.ButtonPreview }}</ui-btn>
          </div>

          <widgets-alert v-if="previewError" type="error" class="text-sm mb-3">{{ previewError }}</widgets-alert>
          <p v-else-if="previewResult && !previewDecisions.length" cy-id="previewEmpty" class="text-sm text-gray-300 py-3">{{ $strings.MessageAutomaticDownloadPreviewEmpty }}</p>
          <div v-else-if="previewDecisions.length" cy-id="previewResults" class="overflow-x-auto border border-white/10 rounded-sm">
            <table class="w-full text-sm">
              <thead class="bg-primary">
                <tr>
                  <th class="text-left px-3 py-2">{{ $strings.LabelEpisodeTitle }}</th>
                  <th class="text-left px-3 py-2 w-32">{{ $strings.LabelStatus }}</th>
                  <th class="text-left px-3 py-2 w-48">{{ $strings.LabelReason }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(decision, index) in previewDecisions" :key="previewDecisionKey(decision, index)" cy-id="previewRow" class="border-t border-white/10">
                  <td dir="auto" class="px-3 py-2">
                    <p>{{ decision.episode.title || $strings.LabelUntitled }}</p>
                    <p v-if="decision.episode.publishedAt" class="text-xs text-gray-400">{{ $formatDate(decision.episode.publishedAt) }}</p>
                  </td>
                  <td class="px-3 py-2" :class="decision.selected ? 'text-success' : 'text-gray-300'">{{ previewStatus(decision) }}</td>
                  <td class="px-3 py-2 text-gray-300">{{ previewReason(decision.reason) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </div>

    <div v-if="feedUrl || autoDownloadEpisodes" class="absolute bottom-0 left-0 w-full py-2 md:py-4 bg-bg border-t border-white/5">
      <div class="flex items-center px-2 md:px-4">
        <div class="grow" />
        <ui-btn @click="save" :disabled="!isUpdated" :color="isUpdated ? 'bg-success' : 'bg-primary'" class="mx-2">{{ isUpdated ? $strings.ButtonSave : $strings.MessageNoUpdatesWereNecessary }}</ui-btn>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  props: {
    processing: Boolean,
    libraryItem: {
      type: Object,
      default: () => {}
    }
  },
  data() {
    return {
      enableAutoDownloadEpisodes: false,
      cronExpression: null,
      newMaxEpisodesToKeep: 0,
      newMaxNewEpisodesToDownload: 0,
      newExcludeTrailers: false,
      newExcludeBonusEpisodes: false,
      newExcludeTitlePhrase: '',
      previewLoading: false,
      previewResult: null,
      previewError: ''
    }
  },
  watch: {
    libraryItem: {
      immediate: true,
      handler(newVal) {
        if (newVal) this.init()
      }
    }
  },
  computed: {
    isProcessing: {
      get() {
        return this.processing
      },
      set(val) {
        this.$emit('update:processing', val)
      }
    },
    userIsAdminOrUp() {
      return this.$store.getters['user/getIsAdminOrUp']
    },
    media() {
      return this.libraryItem ? this.libraryItem.media || {} : {}
    },
    mediaMetadata() {
      return this.media.metadata || {}
    },
    libraryItemId() {
      return this.libraryItem ? this.libraryItem.id : null
    },
    feedUrl() {
      return this.mediaMetadata.feedUrl
    },
    autoDownloadEpisodes() {
      return !!this.media.autoDownloadEpisodes
    },
    autoDownloadSchedule() {
      return this.media.autoDownloadSchedule
    },
    maxEpisodesToKeep() {
      return this.media.maxEpisodesToKeep
    },
    maxNewEpisodesToDownload() {
      return this.media.maxNewEpisodesToDownload
    },
    excludeTrailers() {
      return !!this.media.excludeTrailers
    },
    excludeBonusEpisodes() {
      return !!this.media.excludeBonusEpisodes
    },
    excludeTitlePhrase() {
      return this.media.excludeTitlePhrase || ''
    },
    previewDecisions() {
      return this.previewResult?.decisions || []
    },
    isUpdated() {
      return this.autoDownloadSchedule !== this.cronExpression || this.autoDownloadEpisodes !== this.enableAutoDownloadEpisodes || this.maxEpisodesToKeep !== Number(this.newMaxEpisodesToKeep) || this.maxNewEpisodesToDownload !== Number(this.newMaxNewEpisodesToDownload) || this.excludeTrailers !== this.newExcludeTrailers || this.excludeBonusEpisodes !== this.newExcludeBonusEpisodes || this.excludeTitlePhrase !== this.newExcludeTitlePhrase.trim()
    }
  },
  methods: {
    updatedMaxEpisodesToKeep() {
      if (isNaN(this.newMaxEpisodesToKeep) || this.newMaxEpisodesToKeep < 0) {
        this.newMaxEpisodesToKeep = 0
      } else {
        this.newMaxEpisodesToKeep = Number(this.newMaxEpisodesToKeep)
      }
    },
    updateMaxNewEpisodesToDownload() {
      if (isNaN(this.newMaxNewEpisodesToDownload) || this.newMaxNewEpisodesToDownload < 0) {
        this.newMaxNewEpisodesToDownload = 0
      } else {
        this.newMaxNewEpisodesToDownload = Number(this.newMaxNewEpisodesToDownload)
      }
      this.clearPreview()
    },
    save() {
      // If custom expression input is focused then unfocus it instead of submitting
      if (this.$refs.cronExpressionBuilder && this.$refs.cronExpressionBuilder.checkBlurExpressionInput) {
        if (this.$refs.cronExpressionBuilder.checkBlurExpressionInput()) {
          return
        }
      }

      if (this.$refs.maxEpisodesInput?.isFocused) {
        this.$refs.maxEpisodesInput.blur()
      }
      if (this.$refs.maxEpisodesToDownloadInput?.isFocused) {
        this.$refs.maxEpisodesToDownloadInput.blur()
      }

      const updatePayload = {
        autoDownloadEpisodes: this.enableAutoDownloadEpisodes
      }
      if (this.enableAutoDownloadEpisodes) {
        updatePayload.autoDownloadSchedule = this.cronExpression
      }
      this.newMaxEpisodesToKeep = Number(this.newMaxEpisodesToKeep)
      if (this.newMaxEpisodesToKeep !== this.maxEpisodesToKeep) {
        updatePayload.maxEpisodesToKeep = this.newMaxEpisodesToKeep
      }
      this.newMaxNewEpisodesToDownload = Number(this.newMaxNewEpisodesToDownload)
      if (this.newMaxNewEpisodesToDownload !== this.maxNewEpisodesToDownload) {
        updatePayload.maxNewEpisodesToDownload = this.newMaxNewEpisodesToDownload
      }
      updatePayload.excludeTrailers = this.newExcludeTrailers
      updatePayload.excludeBonusEpisodes = this.newExcludeBonusEpisodes
      updatePayload.excludeTitlePhrase = this.newExcludeTitlePhrase.trim()

      this.updateDetails(updatePayload)
    },
    clearPreview() {
      this.previewResult = null
      this.previewError = ''
    },
    async loadPreview() {
      this.previewLoading = true
      this.clearPreview()
      const feedResult = await this.$axios.$post('/api/podcasts/feed', { rssFeed: this.feedUrl }).catch((error) => {
        console.error('Failed to get podcast feed for preview', error)
        this.previewError = typeof error?.response?.data === 'string' ? error.response.data : this.$strings.ToastPodcastGetFeedFailed
        return null
      })
      if (!feedResult?.podcast?.episodes) {
        if (!this.previewError) this.previewError = this.$strings.ToastPodcastGetFeedFailed
        this.previewLoading = false
        return
      }

      const previewPayload = {
        feed: feedResult.podcast,
        filters: {
          excludeTrailers: this.newExcludeTrailers,
          excludeBonusEpisodes: this.newExcludeBonusEpisodes,
          excludeTitlePhrase: this.newExcludeTitlePhrase
        },
        maxNewEpisodesToDownload: Number(this.newMaxNewEpisodesToDownload)
      }
      this.previewResult = await this.$axios.$post(`/api/podcasts/${this.libraryItemId}/preview-auto-downloads`, previewPayload).catch((error) => {
        console.error('Failed to preview automatic downloads', error)
        this.previewError = typeof error?.response?.data === 'string' ? error.response.data : this.$strings.ToastAutomaticDownloadPreviewFailed
        return null
      })
      this.previewLoading = false
    },
    previewStatus(decision) {
      if (decision.selected) return this.$strings.LabelSelected
      if (decision.eligible) return this.$strings.LabelNotSelected
      return this.$strings.LabelExcluded
    },
    previewReason(reason) {
      const keys = {
        trailer: 'ReasonPodcastTrailer',
        bonus: 'ReasonPodcastBonus',
        'title-phrase': 'ReasonPodcastTitlePhrase',
        'date-cutoff': 'ReasonPodcastDateCutoff',
        'already-downloaded': 'ReasonPodcastAlreadyDownloaded',
        'count-limit': 'ReasonPodcastCountLimit'
      }
      return reason ? this.$strings[keys[reason]] || reason : this.$strings.ReasonPodcastEligible
    },
    previewDecisionKey(decision, index) {
      return decision.episode.guid || decision.episode.enclosure?.url || index
    },
    async updateDetails(updatePayload) {
      this.isProcessing = true
      var updateResult = await this.$axios.$patch(`/api/items/${this.libraryItemId}/media`, updatePayload).catch((error) => {
        console.error('Failed to update', error)
        const errorMessage = typeof error?.response?.data === 'string' ? error?.response?.data : null
        this.$toast.error(errorMessage || this.$strings.ToastFailedToUpdate)
        return false
      })
      this.isProcessing = false
      if (updateResult) {
        if (updateResult.updated) {
          this.$toast.success(this.$strings.ToastItemDetailsUpdateSuccess)
          return true
        } else {
          this.$toast.info(this.$strings.MessageNoUpdatesWereNecessary)
        }
      }
      return false
    },
    init() {
      this.enableAutoDownloadEpisodes = this.autoDownloadEpisodes
      this.cronExpression = this.autoDownloadSchedule
      this.newMaxEpisodesToKeep = this.maxEpisodesToKeep
      this.newMaxNewEpisodesToDownload = this.maxNewEpisodesToDownload
      this.newExcludeTrailers = this.excludeTrailers
      this.newExcludeBonusEpisodes = this.excludeBonusEpisodes
      this.newExcludeTitlePhrase = this.excludeTitlePhrase
      this.clearPreview()
    }
  },
  mounted() {
    this.init()
  }
}
</script>

<style scoped>
#scheduleWrapper {
  height: calc(100% - 80px);
  max-height: calc(100% - 80px);
}
</style>
