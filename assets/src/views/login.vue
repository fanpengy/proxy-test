<template>
  <n-card class="fullscreen-card">
    <iframe ref="pikpak" class="nested-website" :src="iframeSrc"></iframe>
    <template #action>
      <n-button type="primary" @click="handleClick" class="footer-btn">点击操作</n-button>
    </template>
  </n-card>
</template>

<script setup>
import { ref } from 'vue'
import { onMounted } from '@vue/runtime-core'
import { NCard, NButton } from 'naive-ui'

const pikpak = ref(null)
const domain = ref('')
const iframeSrc = ref(domain.value + "/api/proxy?url=https://mypikpak.com/zh-CN")

const handleClick = () => {
  console.log(window.location.origin)
  const innerStorage = pikpak.value.contentWindow.localStorage;
  const data = innerStorage.getItem('deviceid');
  console.log(data)
}
onMounted(() => {
  domain.value = window.location.origin
})
</script>

<style scoped>
.fullscreen-card {
  width: 100vw;
  height: 100vh;
  margin: 0;
  border-radius: 0;
  display: flex;
  flex-direction: column;
}

.nested-website {
  flex: 1;
  width: 100%;
  border: none;
  height: calc(100vh - 60px);
}

.footer-btn {
  margin: 12px;
  align-self: flex-end;
}
</style>
