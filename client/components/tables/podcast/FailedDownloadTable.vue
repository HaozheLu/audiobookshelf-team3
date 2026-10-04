<template>
  <div class="w-full my-8">
    <div class="w-full bg-primary px-4 md:px-6 py-2 flex items-center">
      <p class="pr-2 md:pr-4">{{ $strings.HeaderFailedDownloads }}</p>
      <div class="h-5 md:h-7 w-5 md:w-7 rounded-full bg-white/10 flex items-center justify-center">
        <span class="text-sm font-mono">{{ failures.length }}</span>
      </div>
    </div>
    <transition name="slide">
      <div class="w-full">
        <table class="text-sm tracksTable">
          <tr>
            <th class="text-left px-4 min-w-48">{{ $strings.LabelPodcast }}</th>
            <th class="text-left px-4">{{ $strings.LabelEpisodeTitle }}</th>
            <th class="text-left px-4 w-40">{{ $strings.LabelFailure }}</th>
            <th class="text-left px-4 w-48">{{ $strings.LabelFinished }}</th>
            <th class="text-left px-4 w-24"></th>
          </tr>
          <tr v-for="failure in failures" :key="failure.id">
            <td class="px-4">
              <div class="flex items-center">
                <nuxt-link :to="`/item/${failure.libraryItemId}`" class="text-sm text-gray-200 hover:underline">{{ failure.podcastTitle }}</nuxt-link>
                <widgets-explicit-indicator v-if="failure.podcastExplicit" />
              </div>
            </td>
            <td dir="auto" class="px-4">
              {{ failure.episodeDisplayTitle }}
            </td>
            <td class="px-4">
              {{ getFailureCategoryLabel(failure.failureCategory) }}
            </td>
            <td class="px-4 text-xs">
              {{ $dateDistanceFromNow(failure.finishedAt) }}
            </td>
            <td class="px-4">
              <div class="flex items-center justify-end">
                <ui-tooltip :text="$strings.LabelRetry" direction="top">
                  <span
                    class="material-symbols text-lg cursor-pointer hover:text-white"
                    :class="pendingId === failure.id ? 'opacity-50 pointer-events-none' : ''"
                    @click="$emit('retry', failure.id)"
                    >refresh</span
                  >
                </ui-tooltip>
                <ui-tooltip :text="$strings.LabelDismiss" direction="top">
                  <span
                    class="material-symbols text-lg cursor-pointer hover:text-error ml-3"
                    :class="pendingId === failure.id ? 'opacity-50 pointer-events-none' : ''"
                    @click="$emit('dismiss', failure.id)"
                    >close</span
                  >
                </ui-tooltip>
              </div>
            </td>
          </tr>
        </table>
      </div>
    </transition>
  </div>
</template>

<script>
export default {
  props: {
    failures: {
      type: Array,
      default: () => []
    },
    pendingId: {
      type: String,
      default: null
    }
  },
  methods: {
    getFailureCategoryLabel(category) {
      const labels = {
        transfer: this.$strings.LabelDownloadFailureTransfer,
        probing: this.$strings.LabelDownloadFailureProbing,
        persistence: this.$strings.LabelDownloadFailurePersistence
      }
      return labels[category] || this.$strings.LabelUnknown
    }
  }
}
</script>
