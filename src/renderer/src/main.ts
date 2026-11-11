import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import 'primeicons/primeicons.css'
import App from './App.vue'
import './style.css'

createApp(App)
  .use(createPinia())
  .use(PrimeVue, { theme: { preset: Aura } })
  .mount('#app')
