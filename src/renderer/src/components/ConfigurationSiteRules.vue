<script setup lang="ts">
import { computed, ref } from 'vue'
import Button from 'primevue/button'
import type {
  AppSettings,
  DomainRequestDelayPreference,
  SiteExtractionMode,
  SiteExtractionPreference
} from '../../../shared/contracts'
import { toMessage } from '../../../shared/errors'
import {
  DEFAULT_DOMAIN_REQUEST_DELAY_MS,
  MAX_DOMAIN_REQUEST_DELAY_MS,
  MAX_DOMAIN_REQUEST_PREFERENCES,
  MIN_DOMAIN_REQUEST_DELAY_MS
} from '../../../shared/constants'
import { normalizeDomainRequestDelays } from '../../../shared/domainRequestPreferences'
import {
  normalizeSiteExtractionPreferences,
  normalizeSiteHostname
} from '../../../shared/siteExtractionPreferences'
import {
  syncListDraft,
  useSettingsSave,
  type SettingsSectionEvents
} from '../composables/useSettingsSave'

const props = defineProps<{ settings: AppSettings }>()
const emit = defineEmits<SettingsSectionEvents>()
const { saving, save } = useSettingsSave(
  (settings, message) => emit('saved', settings, message),
  (message) => emit('failed', message)
)

const domainRequestDelaysDraft = ref<DomainRequestDelayPreference[]>([])
const siteExtractionPreferencesDraft = ref<SiteExtractionPreference[]>([])
const domainHostnameDraft = ref('')
const domainDelayDraft = ref(DEFAULT_DOMAIN_REQUEST_DELAY_MS)
const siteHostnameDraft = ref('')
const siteModeDraft = ref<SiteExtractionMode>('generic-html')

syncListDraft(() => props.settings.domainRequestDelays, domainRequestDelaysDraft)
syncListDraft(() => props.settings.siteExtractionPreferences, siteExtractionPreferencesDraft)

const domainRequestDelaysDirty = computed(
  () =>
    JSON.stringify(domainRequestDelaysDraft.value) !==
    JSON.stringify(props.settings.domainRequestDelays)
)
const siteExtractionPreferencesDirty = computed(
  () =>
    JSON.stringify(siteExtractionPreferencesDraft.value) !==
    JSON.stringify(props.settings.siteExtractionPreferences)
)

function addDomainRequestDelay(): void {
  try {
    const hostname = normalizeSiteHostname(domainHostnameDraft.value)
    domainRequestDelaysDraft.value = normalizeDomainRequestDelays([
      ...domainRequestDelaysDraft.value.filter((preference) => preference.hostname !== hostname),
      { hostname, delayMs: domainDelayDraft.value }
    ])
    domainHostnameDraft.value = ''
  } catch (reason) {
    emit('failed', toMessage(reason))
  }
}

function removeDomainRequestDelay(hostname: string): void {
  domainRequestDelaysDraft.value = domainRequestDelaysDraft.value.filter(
    (preference) => preference.hostname !== hostname
  )
}

function addSiteExtractionPreference(): void {
  try {
    const hostname = normalizeSiteHostname(siteHostnameDraft.value)
    siteExtractionPreferencesDraft.value = normalizeSiteExtractionPreferences([
      ...siteExtractionPreferencesDraft.value.filter((preference) => preference.hostname !== hostname),
      { hostname, mode: siteModeDraft.value }
    ])
    siteHostnameDraft.value = ''
  } catch (reason) {
    emit('failed', toMessage(reason))
  }
}

function removeSiteExtractionPreference(hostname: string): void {
  siteExtractionPreferencesDraft.value = siteExtractionPreferencesDraft.value.filter(
    (preference) => preference.hostname !== hostname
  )
}

const saveDomainRequestDelays = (): Promise<unknown> =>
  save(
    'domainDelays',
    { domainRequestDelays: domainRequestDelaysDraft.value.map((preference) => ({ ...preference })) },
    'Per-domain request delays saved.'
  )
const saveSiteExtractionPreferences = (): Promise<unknown> =>
  save(
    'siteParsers',
    {
      siteExtractionPreferences: siteExtractionPreferencesDraft.value.map((preference) => ({
        ...preference
      }))
    },
    'Site extraction preferences saved.'
  )
</script>

<template>
  <section class="card" aria-labelledby="configuration-site-rules-heading">
    <div class="section-heading">
      <div>
        <p class="step-label">SITE RULES</p>
        <h3 id="configuration-site-rules-heading">Request delays and chapter-list parsers</h3>
      </div>
    </div>
    <div class="site-extraction-settings">
      <div>
        <strong>Per-domain request delay</strong>
        <p class="help-text">
          Set the minimum spacing between request starts for each hostname. Unlisted domains use the built-in default of
          {{ DEFAULT_DOMAIN_REQUEST_DELAY_MS }} ms. Faster values are bounded by built-in site safety intervals; slower values are honored. HTTP 429 cooldowns always apply.
        </p>
      </div>
      <div class="site-extraction-preference-form">
        <input
          v-model="domainHostnameDraft"
          class="site-extraction-hostname"
          type="text"
          placeholder="example.com"
          aria-label="Domain hostname"
          :disabled="saving !== null"
        />
        <input
          v-model.number="domainDelayDraft"
          class="configuration-number"
          type="number"
          :min="MIN_DOMAIN_REQUEST_DELAY_MS"
          :max="MAX_DOMAIN_REQUEST_DELAY_MS"
          step="50"
          aria-label="Request delay in milliseconds"
          :disabled="saving !== null"
        />
        <Button
          icon="pi pi-plus"
          title="Add or update domain delay"
          aria-label="Add or update domain delay"
          size="small"
          :disabled="saving !== null"
          @click="addDomainRequestDelay"
        />
      </div>
      <small class="help-text">
        {{ domainRequestDelaysDraft.length }} of {{ MAX_DOMAIN_REQUEST_PREFERENCES }} configured domains. Delay range: {{ MIN_DOMAIN_REQUEST_DELAY_MS }}–{{ MAX_DOMAIN_REQUEST_DELAY_MS }} ms.
      </small>
      <div v-if="domainRequestDelaysDraft.length" class="site-extraction-preference-list">
        <div v-for="preference in domainRequestDelaysDraft" :key="preference.hostname" class="site-extraction-preference-row">
          <strong>{{ preference.hostname }}</strong>
          <input
            v-model.number="preference.delayMs"
            class="configuration-number"
            type="number"
            :min="MIN_DOMAIN_REQUEST_DELAY_MS"
            :max="MAX_DOMAIN_REQUEST_DELAY_MS"
            step="50"
            :aria-label="`Request delay in milliseconds for ${preference.hostname}`"
            :disabled="saving !== null"
          />
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            :title="`Remove request delay for ${preference.hostname}`"
            :aria-label="`Remove request delay for ${preference.hostname}`"
            :disabled="saving !== null"
            @click="removeDomainRequestDelay(preference.hostname)"
          />
        </div>
      </div>
      <Button
        icon="pi pi-save"
        title="Save domain request delays"
        aria-label="Save domain request delays"
        size="small"
        :loading="saving === 'domainDelays'"
        :disabled="saving !== null || !domainRequestDelaysDirty"
        @click="saveDomainRequestDelays"
      />
    </div>
    <div class="site-extraction-settings">
      <div>
        <strong>Per-site chapter-list parser</strong>
        <p class="help-text">Automatic uses the built-in site detector. Generic HTML is available for other chapter-list pages; NovelFull is available only for compatible NovelFull URLs. These preferences are saved locally.</p>
      </div>
      <div class="site-extraction-preference-form">
        <input
          v-model="siteHostnameDraft"
          class="site-extraction-hostname"
          type="text"
          placeholder="example.com"
          aria-label="Website hostname"
          :disabled="saving !== null"
        />
        <select v-model="siteModeDraft" class="configuration-select" aria-label="Chapter-list parser">
          <option value="automatic">Automatic</option>
          <option value="generic-html">Generic HTML</option>
          <option value="novelfull">NovelFull</option>
        </select>
        <Button
          icon="pi pi-plus"
          title="Add or update site preference"
          aria-label="Add or update site preference"
          size="small"
          :disabled="saving !== null"
          @click="addSiteExtractionPreference"
        />
      </div>
      <div v-if="siteExtractionPreferencesDraft.length" class="site-extraction-preference-list">
        <div v-for="preference in siteExtractionPreferencesDraft" :key="preference.hostname" class="site-extraction-preference-row">
          <strong>{{ preference.hostname }}</strong>
          <select v-model="preference.mode" class="configuration-select" aria-label="Saved chapter-list parser">
            <option value="automatic">Automatic</option>
            <option value="generic-html">Generic HTML</option>
            <option value="novelfull">NovelFull</option>
          </select>
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            :title="`Remove extraction preference for ${preference.hostname}`"
            :aria-label="`Remove extraction preference for ${preference.hostname}`"
            :disabled="saving !== null"
            @click="removeSiteExtractionPreference(preference.hostname)"
          />
        </div>
      </div>
      <Button
        icon="pi pi-save"
        title="Save site preferences"
        aria-label="Save site preferences"
        size="small"
        :loading="saving === 'siteParsers'"
        :disabled="saving !== null || !siteExtractionPreferencesDirty"
        @click="saveSiteExtractionPreferences"
      />
    </div>
  </section>
</template>
