import { utimes } from 'fs/promises'
import * as path from 'upath'
import _debug from 'debug'
import { normalizePath } from 'vite'
import { cacheDir, writeStyles, resolveVuetifyBase } from '@vuetify/loader-shared'

import type { Plugin, ViteDevServer } from 'vite'
import type { Options } from '@vuetify/loader-shared'
import type { PluginContext } from 'rollup'

const debug = _debug('vuetify:styles')

function isSubdir (root: string, test: string) {
  const relative = path.relative(root, test)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
}

const styleImportRegexp = /(@use |meta\.load-css\()['"](vuetify(?:\/lib)?(?:\/styles(?:\/main(?:\.sass)?)?)?)['"]/

export function stylesPlugin (options: Options): Plugin {
  const vuetifyBase = resolveVuetifyBase()
  const files = new Set<string>()

  let server: ViteDevServer
  let context: PluginContext
  let resolve: (v: boolean) => void
  let promise: Promise<boolean> | null
  let needsTouch = false
  const blockingModules = new Set<string>()

  let pendingModules: string[]
  async function getPendingModules () {
    if (!server) {
      await new Promise(resolve => setTimeout(resolve, 0))
      const modules = Array.from(context.getModuleIds())
        .filter(id => {
          return !blockingModules.has(id) && // Ignore the current file
            !/\w\.(s[ac]|c)ss/.test(id) // Ignore stylesheets
        })
        .map(id => context.getModuleInfo(id)!)
        .filter(module => module.code == null) // Ignore already loaded modules

      pendingModules = modules.map(module => module.id)
      if (!pendingModules.length) return 0

      const promises = modules.map(module => context.load(module))
      await Promise.race(promises)

      return promises.length
    } else {
      const modules = Array.from(server.moduleGraph.urlToModuleMap.entries())
        .filter(([k, v]) => (
          v.transformResult == null && // Ignore already loaded modules
          !k.startsWith('/@id/') &&
          !/\w\.(s[ac]|c)ss/.test(k) && // Ignore stylesheets
          !blockingModules.has(v.id!) && // Ignore the current file
          !/\/node_modules\/\.vite\/deps\/(?!vuetify[._])/.test(k) // Ignore dependencies
        ))

      pendingModules = modules.map(([, v]) => v.id!)
      if (!pendingModules.length) return 0

      const promises = modules.map(([k, v]) => server.transformRequest(k).then(() => v))
      await Promise.race(promises)

      return promises.length
    }
  }

  let timeout: NodeJS.Timeout
  async function awaitBlocking () {
    let pending
    do {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        console.error('vuetify:styles fallback timeout hit', {
          blockingModules: Array.from(blockingModules.values()),
          pendingModules,
          pendingRequests: server?._pendingRequests.keys()
        })
        resolve(false)
      }, options.stylesTimeout)

      pending = await Promise.any<boolean | number | null>([
        promise,
        getPendingModules()
      ])
      debug(pending, 'pending modules', pendingModules)
    } while (pending)

    resolve(false)
  }

  async function awaitResolve (id?: string) {
    if (id) {
      blockingModules.add(id)
    }

    if (!promise) {
      promise = new Promise((_resolve) => resolve = _resolve)

      awaitBlocking()
      await promise
      clearTimeout(timeout)
      blockingModules.clear()

      debug('writing styles')
      await writeStyles(files)

      if (server && needsTouch) {
        const cacheFile = normalizePath(cacheDir('styles.scss'))
        server.moduleGraph.getModulesByFile(cacheFile)?.forEach(module => {
          module.importers.forEach(module => {
            if (module.file) {
              const now = new Date()
              debug(`touching ${module.file}`)
              utimes(module.file, now, now)
            }
          })
        })
        needsTouch = false
      }
      promise = null
    }

    return promise
  }

  let configFile: string | undefined
  const tempFiles = new Map<string, string>()

  return {
    name: 'vuetify:styles',
    enforce: 'pre',
    configureServer (_server) {
      server = _server
    },
    buildStart () {
      if (!server) {
        context = this
      }
    },
    configResolved (config) {
      if (typeof options.styles === 'object') {
        if (path.isAbsolute(options.styles.configFile)) {
          configFile = options.styles.configFile
        } else {
          configFile = path.join(config.root || process.cwd(), options.styles.configFile)
        }
      }
    },
    async resolveId (source, importer, { custom }) {
      if (
        source === 'vuetify/styles' || (
          importer &&
          source.endsWith('.css') &&
          isSubdir(vuetifyBase, path.isAbsolute(source) ? source : importer)
        )
      ) {
        if (options.styles === 'none') {
          return '\0__void__'
        } else if (options.styles === 'sass') {
          const target = source.replace(/\.css$/, '.sass')
          return this.resolve(target, importer, { skipSelf: true, custom })
        } else if (options.styles === 'expose') {
          awaitResolve()

          const resolution = await this.resolve(
            source.replace(/\.css$/, '.sass'),
            importer,
            { skipSelf: true, custom }
          )

          if (resolution) {
            if (!files.has(resolution.id)) {
              needsTouch = true
              files.add(resolution.id)
            }

            return '\0__void__'
          }
        } else if (typeof options.styles === 'object') {
          const resolution = await this.resolve(source, importer, { skipSelf: true, custom })

          if (!resolution) return null

          const target = resolution.id.replace(/\.css$/, '.sass')
          const file = path.relative(path.join(vuetifyBase, 'lib'), target)


          const contents = scssFileContents(options.useLayers, configFile, target)

          tempFiles.set(file, contents)

          return `\0plugin-vuetify:${file}`
        }
      } else if (source.startsWith('/plugin-vuetify:')) {
        return '\0' + source.slice(1)
      } else if (source.startsWith('/@id/__x00__plugin-vuetify:')) {
        return '\0' + source.slice(12)
      }

      return null
    },
    async transform (code, id) {
      if (
        options.styles === 'expose' &&
        ['.scss', '.sass'].some(v => id.endsWith(v)) &&
        styleImportRegexp.test(code)
      ) {
        debug(`awaiting ${id}`)
        await awaitResolve(id)
        debug(`returning ${id}`)

        return {
          code: code.replace(styleImportRegexp, '$1".cache/vuetify/styles.scss"'),
          map: null,
        }
      }
    },
    load (id) {
      // When Vite is configured with `optimizeDeps.exclude: ['vuetify']`, the
      // received id contains a version hash (e.g. \0__void__?v=893fa859).
      if (/^\0__void__(\?.*)?$/.test(id)) {
        return ''
      }

      if (id.startsWith('\0plugin-vuetify')) {
        const file = /^\0plugin-vuetify:(.*?)(\?.*)?$/.exec(id)![1]

        return tempFiles.get(file)
      }

      return null
    },
  }
}

function scssFileContents(useLayers: boolean | undefined, configFile: string | undefined, target: string) {

  if (useLayers) {
    return `@use 'sass:meta';\n @use "${configFile};\n @layer framework {\n @include meta.load-css("${target}");\n }\n`
  }

  return `@use "${configFile}"\n@use "${target}"`
}