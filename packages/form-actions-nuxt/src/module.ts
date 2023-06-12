import { existsSync, promises as fsp } from "node:fs"
import { resolve as pathResolve } from "node:path"
import { addImports, addPlugin, addServerHandler, addTemplate, createResolver, defineNuxtModule, updateTemplates, useLogger } from "@nuxt/kit"
import { generateCode, loadFile } from "magicast"
import { transform } from "esbuild"
import { NITRO_LOADER_PREFIX, loaderTypesAfter, loaderTypesBefore } from "./runtime/utils"

const GENERATED_TEXT = "/** This file is auto-generated by the form-actions module. /!\\ Do not modify it manually ! */ \n"

async function* walkFiles(dir: string): AsyncGenerator<string> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const res = pathResolve(dir, entry.name)
    if (entry.isDirectory()) {
      yield * walkFiles(res)
    }
    else {
      yield res
    }
  }
}

async function writeLoader(file: Awaited<ReturnType<typeof loadFile<any>>>, loaderDirectory = "", actionRoute = "") {
  file.exports.default = file.exports.loader
  delete file.exports.loader
  const { code } = generateCode(file) // We extract it with magicast...
  const shaked = await transform(code, { treeShaking: true, loader: "ts" }) // ...we clean it with esbuild ...
  const handler = `${loaderDirectory}/${actionRoute}.ts`
  await fsp.writeFile(handler, GENERATED_TEXT)
  await fsp.appendFile(handler, shaked.code) // ...and we write it to the loader directory @todo Use virtualfiles ?
  return handler
}

function getActionRoute(actionPath: string) {
  const actionRegex = /actions\/(.*?)\.ts/
  const actionRoute = actionRegex.exec(actionPath)?.[1]
  if (!actionRoute) throw new Error(`Could not parse action route from ${actionPath}`)
  return actionRoute
}

const getLoaderRoute = (route: string) => `/${NITRO_LOADER_PREFIX}/${route}`

const name = "form-actions"
export default defineNuxtModule({
  meta: {
    name
  },
  async setup(userOptions, nuxt) {
    const logger = useLogger(name)
    const { resolve } = createResolver(import.meta.url)

    logger.info(`Adding ${name} module...`)

    // 0. Local variables and setup
    const loaderDirname = ".loader" as const
    const loaderTypesFilename = "types/form-action-loaders.d.ts" as const
    const actionDirectoryPath = resolve(nuxt.options.srcDir, "server/actions")
    if (!existsSync(actionDirectoryPath)) await fsp.mkdir(actionDirectoryPath)
    // Loaders
    const loaderDirectory = resolve(actionDirectoryPath, `../${loaderDirname}`)
    const loaderMap = new Map()
    nuxt.options.runtimeConfig.public.__serverLoaders__ = []
    const serverLoaders = () => nuxt.options.runtimeConfig.public.__serverLoaders__ as string[]

    // 1. Add H3 & Nitro imports
    nuxt.hook("nitro:config", (nitroConfig) => {
      nitroConfig.alias = nitroConfig.alias || {}
      nitroConfig.alias[`#${name}`] = resolve("./runtime/server")
    })

    // Add types
    const filename = `types/${name}.d.ts`
    addTemplate({
      filename,
      getContents: () => `
      declare module '#${name}' {
      ${["getRequestFromEvent", "respondWithResponse", "respondWithRedirect", "getFormData", "defineServerLoader", "defineFormActions", "actionResponse"]
        .map(name => `const ${name}: typeof import('${resolve("./runtime/server")}')['${name}']`).join("\n")}
      }`
    })

    nuxt.hook("prepare:types", (options) => {
      options.references.push({ path: resolve(nuxt.options.buildDir, filename) })
    })

    const addLoaderTypes = () => {
      const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
      const loaders = () => Array.from(loaderMap.values())
      return addTemplate({
        filename: loaderTypesFilename,
        write: true,
        getContents: () => {
          const l = loaders()
          return `
          ${loaderTypesBefore}

          type LoaderUrl = ${l.map(l => `"${l.url}"`).join(" | ")}

          type LoaderName = ${l.map(l => `"${l.name}"`).join(" | ")}
          
          ${l.map(l => `type Loader${capitalize(l.name)} = typeof import("${l.filePath}").default`).join("\n")}

          export interface Loaders {
            ${l.map(l => `"${l.name}": ExtractLoader<Loader${capitalize(l.name)}>`).join("\n")}
          }

          ${loaderTypesAfter}
          `
        }
      })
    }

    nuxt.hook("nitro:config", async (nitro) => {
      nitro.runtimeConfig = nitro.runtimeConfig || {}

      // Loaders
      if (existsSync(loaderDirectory)) await fsp.rm(loaderDirectory, { recursive: true })
      await fsp.mkdir(loaderDirectory)
      await fsp.writeFile(`${loaderDirectory}/.gitignore`, "*")

      // Form Actions
      nitro.handlers = nitro.handlers || []

      for await (const actionPath of walkFiles(actionDirectoryPath)) {
        const actionRoute = getActionRoute(actionPath)
        const route = `/${actionRoute}`
        // Add the action handler ...
        const file = await loadFile(actionPath)
        if (file.exports.default) {
          nitro.handlers.push({
            route,
            handler: actionPath,
            formAction: true
          })
          logger.success(`[form-actions] {form action} added : '${route}'`)
        }

        // 3. defineServerLoader
        // Find loaders with magicast and add a  GET handler for each one of them.
        if (file.exports.loader) {
          const handler = await writeLoader(file, loaderDirectory, actionRoute)
          const route = getLoaderRoute(actionRoute)
          nitro.handlers.push({
            method: "get",
            route,
            lazy: true,
            handler
          })
          logger.success(`[form-actions] {loader} added '${actionRoute}' at '${route}'`)
          serverLoaders().push(actionRoute)

          // Add loader to the types array
          loaderMap.set(actionRoute, { name: actionRoute, filePath: handler, url: route })
          logger.success(`[form-actions] {loader} added type for '${actionRoute}'`)
        }
      }
      addLoaderTypes()
      logger.success(`[form-actions] {loader} added to the config : ${serverLoaders().join(", ")}`)
    })

    // Regenerate loaders when the action changes.
    nuxt.options.ignore = nuxt.options.ignore || []
    nuxt.options.ignore.push(`server/${loaderDirname}}/**`)
    nuxt.hook("builder:watch", async (event, path) => {
      try {
        if (path.includes("server/actions")) {
          logger.info(`[form-actions] changed '@${event}'`, path)
          const actionRoute = getActionRoute(path) // This will throw if there's no actionRoute

          const removeLoaderFromServerLoader = () => {
            if (serverLoaders().includes(actionRoute)) {
              nuxt.options.runtimeConfig.public.__serverLoaders__ = serverLoaders().filter((route: string) => route !== actionRoute)
              logger.success(`[form-actions] {loader} removed : '${actionRoute}', [${serverLoaders().join(", ")}]`)
            }
          }
          // Return early if the path doesn't exist.
          if (!existsSync(path)) return removeLoaderFromServerLoader()
          const file = await loadFile(path)
          if (file) {
            const hasHandler = nuxt.options.serverHandlers.some((handler: any) => handler.handler === path)
            // If we don't have a handler for this path, we add it.
            // @todo add nitro scanners for this directory.
            if (!hasHandler) {
              logger.info(`[form-actions] {handler} added new : '${actionRoute}'`)
              addServerHandler({
                method: "post",
                route: `/${actionRoute}`,
                lazy: true,
                handler: path
              })
            }
            // Add or refresh the loader.
            if (file.exports.loader) {
              const handler = await writeLoader(file, loaderDirectory, actionRoute)
              updateTemplates({ filter: t => t.filename === loaderTypesFilename })
              logger.success(`[form-actions] {loader} updated : '${handler}'`)
              // Add to serverLoaders and types if newly created.
              if (!serverLoaders().includes(actionRoute)) {
                loaderMap.set(actionRoute, { name: actionRoute, filePath: handler, url: getLoaderRoute(actionRoute) })
                serverLoaders().push(actionRoute)
                logger.success(`[form-actions] {loader} added new : '${actionRoute}' [${serverLoaders().join(", ")}]`)
              }
            }
            else { // Remove from server loaders if no loader..
              removeLoaderFromServerLoader()
            }
          }
        }
      }
      catch (error) {
        logger.error(`[form-actions] error while handling '${event}'`, error)
      }
    })

    // 4. Add useFormAction composables
    addImports(["useFormAction", "useLoader"].map(name => ({ name, from: resolve(`./runtime/composables/${name}`) })))

    // 5. Add v-enhance directive
    addPlugin(resolve("./runtime/plugin"))

    logger.success(`Added ${name} module successfully.`)
  }
})
