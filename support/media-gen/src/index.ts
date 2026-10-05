/**
 * Shared media-generation assembly for dsh router plugins: the
 * transitions-aware vocabulary (text-to-image, image-to-image,
 * image-to-video, audio-to-audio…), a schema-tolerant result harvester,
 * a file-writing executor with local-input inlining, and the common dsh
 * surfaces (tool, runtime skill, model-list and generate commands).
 *
 * @module @loncothad/dsh-media-gen
 */

export { MediaCatalogService, registerMediaCatalog } from './catalog-service.ts'
export * from './executor.ts'
export * from './harvest.ts'
export * from './media.ts'
export * from './options.ts'
export * from './schema.ts'
export { scopedMediaIo } from './scoped-io.ts'
export * from './surfaces.ts'
