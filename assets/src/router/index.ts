import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    redirect: '/list',
    beforeEnter: (to, from, next) => {
      if(to && from) {
       next('/login')
      } else {
        next()
      }
    },
    children: [
      {
        path: 'list/:id?',
        name: 'list',
        component: () => import('../views/list.vue')
      }
    ]
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/login.vue'),
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

export default router