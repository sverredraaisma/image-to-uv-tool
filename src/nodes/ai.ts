// Replicate-backed AI model catalog. Always manual-run so tokens are only spent
// when the user explicitly asks. The node-building machinery lives in
// ./aiFactory; this file is just the (capability-grouped) list of models.

import type { NodeDefinition } from '../types';
import { IMAGE, PROMPT, makeReplicateNode } from './aiFactory';

export const aiNodes: NodeDefinition[] = [
  // ---- Generate (text → image) ----
  makeReplicateNode({
    type: 'fluxSchnell',
    label: 'Flux Schnell',
    group: 'Generate',
    description: 'Fast text-to-image generation (black-forest-labs/flux-schnell).',
    model: 'black-forest-labs/flux-schnell',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'].map((v) => ({ value: v, label: v })),
        },
        default: '1:1',
      },
    ],
  }),
  makeReplicateNode({
    type: 'sdxlLightning',
    label: 'SDXL Lightning',
    group: 'Generate',
    description: 'Near-instant 4-step text-to-image (bytedance/sdxl-lightning-4step).',
    model: 'bytedance/sdxl-lightning-4step',
    ports: [PROMPT()],
  }),
  makeReplicateNode({
    type: 'fluxDev',
    label: 'Flux Dev',
    group: 'Generate',
    description: 'Higher-quality (slower) text-to-image (black-forest-labs/flux-dev).',
    model: 'black-forest-labs/flux-dev',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4'].map((v) => ({ value: v, label: v })),
        },
        default: '1:1',
      },
    ],
  }),
  makeReplicateNode({
    type: 'sdxl',
    label: 'SDXL',
    group: 'Generate',
    description: 'Stable Diffusion XL text-to-image (stability-ai/sdxl).',
    model: 'stability-ai/sdxl',
    ports: [
      PROMPT(),
      {
        id: 'negative_prompt',
        label: 'Negative prompt',
        type: 'text',
        key: 'negative_prompt',
        required: false,
      },
    ],
  }),
  makeReplicateNode({
    type: 'recraftV3',
    label: 'Recraft v3',
    group: 'Generate',
    description: 'High-quality text-to-image with styles (recraft-ai/recraft-v3).',
    model: 'recraft-ai/recraft-v3',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'size',
          label: 'Size',
          options: ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536'].map((v) => ({
            value: v,
            label: v,
          })),
        },
        default: '1024x1024',
      },
    ],
  }),
  makeReplicateNode({
    type: 'ideogramV2',
    label: 'Ideogram v2',
    group: 'Generate',
    description: 'Text-to-image with excellent in-image text rendering (ideogram-ai/ideogram-v2).',
    model: 'ideogram-ai/ideogram-v2',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4'].map((v) => ({ value: v, label: v })),
        },
        default: '1:1',
      },
    ],
  }),
  makeReplicateNode({
    type: 'sd35Large',
    label: 'Stable Diffusion 3.5',
    group: 'Generate',
    description: 'Stable Diffusion 3.5 Large text-to-image (stability-ai/stable-diffusion-3.5-large).',
    model: 'stability-ai/stable-diffusion-3.5-large',
    ports: [
      PROMPT(),
      {
        id: 'negative_prompt',
        label: 'Negative prompt',
        type: 'text',
        key: 'negative_prompt',
        required: false,
      },
    ],
  }),

  // ---- Edit (image + instruction → image) ----
  makeReplicateNode({
    type: 'instructPix2Pix',
    label: 'Instruct Pix2Pix',
    group: 'Edit',
    description: 'Edit an image with a text instruction (timothybrooks/instruct-pix2pix).',
    model: 'timothybrooks/instruct-pix2pix',
    ports: [IMAGE(), PROMPT({ label: 'Instruction' })],
  }),
  makeReplicateNode({
    type: 'sdInpaint',
    label: 'SD Inpainting',
    group: 'Edit',
    description: 'Fill a masked region from a prompt (stability-ai/stable-diffusion-inpainting).',
    model: 'stability-ai/stable-diffusion-inpainting',
    ports: [IMAGE(), { id: 'mask', label: 'Mask', type: 'mask', key: 'mask', required: false }, PROMPT()],
  }),
  makeReplicateNode({
    type: 'fluxFill',
    label: 'Flux Fill',
    group: 'Edit',
    description:
      'High-quality inpaint/outpaint from image + mask + prompt (black-forest-labs/flux-fill-dev).',
    model: 'black-forest-labs/flux-fill-dev',
    ports: [
      IMAGE(),
      { id: 'mask', label: 'Mask', type: 'mask', key: 'mask', required: false },
      PROMPT({ required: false }),
    ],
  }),
  makeReplicateNode({
    type: 'fluxCanny',
    label: 'Flux ControlNet (Canny)',
    group: 'Edit',
    description:
      'Structure-guided generation from a control image + prompt (black-forest-labs/flux-canny-dev).',
    model: 'black-forest-labs/flux-canny-dev',
    ports: [IMAGE({ key: 'control_image', label: 'Control image' }), PROMPT()],
  }),
  makeReplicateNode({
    type: 'fluxKontext',
    label: 'Flux Kontext',
    group: 'Edit',
    description: 'High-quality instruction-based image editing (black-forest-labs/flux-kontext-pro).',
    model: 'black-forest-labs/flux-kontext-pro',
    ports: [IMAGE({ key: 'input_image' }), PROMPT({ label: 'Instruction' })],
  }),
  makeReplicateNode({
    type: 'icLight',
    label: 'Relight (IC-Light)',
    group: 'Edit',
    description: 'Relight a subject from a text prompt (zsxkib/ic-light).',
    model: 'zsxkib/ic-light',
    ports: [IMAGE({ key: 'subject_image' }), PROMPT()],
  }),
  makeReplicateNode({
    type: 'lamaRemove',
    label: 'Remove Object (LaMa)',
    group: 'Edit',
    description: 'Erase a masked region and inpaint the background, no prompt (cjwbw/lama).',
    model: 'cjwbw/lama',
    ports: [IMAGE(), { id: 'mask', label: 'Mask', type: 'mask', key: 'mask', required: true }],
  }),

  // ---- Stylize ----
  makeReplicateNode({
    type: 'animeGan',
    label: 'AnimeGAN v2',
    group: 'Stylize',
    description: 'Cartoon / anime stylisation of a photo (412392713/animegan-v2).',
    model: '412392713/animegan-v2',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'styleTransfer',
    label: 'Style Transfer',
    group: 'Stylize',
    description: 'Restyle an image using a reference style image + prompt (fofr/style-transfer).',
    model: 'fofr/style-transfer',
    ports: [
      IMAGE(),
      { id: 'style', label: 'Style image', type: 'image', key: 'style_image', required: false },
      PROMPT({ required: false }),
    ],
  }),
  makeReplicateNode({
    type: 'faceToSticker',
    label: 'Face to Sticker',
    group: 'Stylize',
    description: 'Turn a face photo into a sticker, prompt-guided (fofr/face-to-sticker).',
    model: 'fofr/face-to-sticker',
    ports: [IMAGE(), PROMPT({ required: false })],
  }),

  // ---- Depth ----
  makeReplicateNode({
    type: 'depthAnythingV2',
    label: 'Depth Anything v2',
    group: 'Depth',
    description: 'Monocular depth estimation (chenxwh/depth-anything-v2). Grey + colour depth outputs.',
    model: 'chenxwh/depth-anything-v2',
    ports: [IMAGE()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'model_size',
          label: 'Model size',
          options: [
            { value: 'Small', label: 'Small' },
            { value: 'Base', label: 'Base' },
            { value: 'Large', label: 'Large' },
          ],
        },
        default: 'Large',
      },
    ],
    outputs: [
      { id: 'grey', label: 'Grey depth', type: 'image', key: 'grey_depth' },
      { id: 'color', label: 'Colour depth', type: 'image', key: 'color_depth' },
    ],
  }),
  makeReplicateNode({
    type: 'marigoldDepth',
    label: 'Marigold Depth',
    group: 'Depth',
    description: 'High-quality diffusion-based depth estimation (prs-eth/marigold).',
    model: 'prs-eth/marigold',
    ports: [IMAGE()],
  }),
  // ---- Segment ----
  makeReplicateNode({
    type: 'sam2Image',
    label: 'SAM 2 (image)',
    group: 'Segment',
    description:
      'Segment Anything 2, automatic masks. Verified slug: meta/sam-2. Point/box prompts go in Extra inputs (JSON).',
    model: 'meta/sam-2',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'sam3Concept',
    label: 'SAM 3 (concept)',
    group: 'Segment',
    description:
      'Segment Anything 3 — segments everything matching a text concept. Default slug is the video model (lucataco/sam3-video); set an image SAM 3 slug/keys if you have one.',
    model: 'lucataco/sam3-video',
    ports: [
      IMAGE({ required: false }),
      { id: 'prompt', label: 'Concept prompt', type: 'text', key: 'prompt', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'groundedSam',
    label: 'Grounded SAM',
    group: 'Segment',
    description:
      'Text-prompted segmentation (Grounding DINO + SAM). Masks what the prompt describes; subtract a negative prompt. Slug: schananas/grounded_sam.',
    model: 'schananas/grounded_sam',
    ports: [
      IMAGE(),
      { id: 'mask_prompt', label: 'Mask prompt', type: 'text', key: 'mask_prompt', required: true },
      {
        id: 'negative_mask_prompt',
        label: 'Negative mask prompt',
        type: 'text',
        key: 'negative_mask_prompt',
        required: false,
      },
    ],
    scalars: [
      {
        field: {
          kind: 'number',
          key: 'adjustment_factor',
          label: 'Adjustment factor',
          min: -25,
          max: 25,
          step: 1,
        },
        default: 0,
      },
    ],
    outputs: [
      { id: 'mask', label: 'Mask', type: 'image', index: 2 },
      { id: 'invertedMask', label: 'Inverted mask', type: 'image', index: 3 },
      { id: 'annotated', label: 'Annotated', type: 'image', index: 0 },
      { id: 'negAnnotated', label: 'Neg. annotated', type: 'image', index: 1 },
    ],
  }),

  // ---- Background removal ----
  makeReplicateNode({
    type: 'birefnetV3',
    label: 'BiRefNet',
    group: 'Background removal',
    description: 'High-accuracy background removal. Verified slug: men1scus/birefnet.',
    model: 'men1scus/birefnet',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'isnetAnime',
    label: 'Background removal (rembg)',
    group: 'Background removal',
    description:
      'Background removal (rembg / IS-Net). Verified slug: cjwbw/rembg. For the isnet-anime variant set model_name via Extra inputs (JSON) if the chosen model supports it.',
    model: 'cjwbw/rembg',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'briaRmbg',
    label: 'Bria RMBG 2.0',
    group: 'Background removal',
    description: 'Commercial-grade background removal (bria/remove-background).',
    model: 'bria/remove-background',
    ports: [IMAGE()],
  }),

  // ---- Restore & upscale ----
  makeReplicateNode({
    type: 'realEsrgan',
    label: 'Real-ESRGAN upscale',
    group: 'Restore & upscale',
    description: 'Upscale / enhance an image (nightmareai/real-esrgan).',
    model: 'nightmareai/real-esrgan',
    ports: [IMAGE()],
    scalars: [
      { field: { kind: 'number', key: 'scale', label: 'Scale', min: 1, max: 10, step: 1 }, default: 4 },
      { field: { kind: 'boolean', key: 'face_enhance', label: 'Face enhance' }, default: false },
    ],
  }),
  makeReplicateNode({
    type: 'gfpgan',
    label: 'GFPGAN face restore',
    group: 'Restore & upscale',
    description: 'Restore faces in an image (tencentarc/gfpgan).',
    model: 'tencentarc/gfpgan',
    ports: [IMAGE({ key: 'img' })],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'version',
          label: 'Version',
          options: ['v1.2', 'v1.3', 'v1.4', 'RestoreFormer'].map((v) => ({ value: v, label: v })),
        },
        default: 'v1.4',
      },
      { field: { kind: 'number', key: 'scale', label: 'Scale', min: 1, max: 10, step: 1 }, default: 2 },
    ],
  }),
  makeReplicateNode({
    type: 'ddcolor',
    label: 'Colorize (DDColor)',
    group: 'Restore & upscale',
    description: 'Colourise black & white photos (piddnad/ddcolor).',
    model: 'piddnad/ddcolor',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'clarityUpscaler',
    label: 'Clarity Upscaler',
    group: 'Restore & upscale',
    description: 'Creative, detail-adding upscaler with an optional prompt (philz1337x/clarity-upscaler).',
    model: 'philz1337x/clarity-upscaler',
    ports: [IMAGE(), PROMPT({ required: false })],
    scalars: [
      {
        field: { kind: 'number', key: 'scale_factor', label: 'Scale factor', min: 1, max: 4, step: 1 },
        default: 2,
      },
    ],
  }),
  makeReplicateNode({
    type: 'codeformer',
    label: 'CodeFormer face restore',
    group: 'Restore & upscale',
    description: 'Face restoration with adjustable fidelity (sczhou/codeformer).',
    model: 'sczhou/codeformer',
    ports: [IMAGE()],
    scalars: [
      {
        field: { kind: 'number', key: 'codeformer_fidelity', label: 'Fidelity', min: 0, max: 1, step: 0.05 },
        default: 0.7,
      },
    ],
  }),
  makeReplicateNode({
    type: 'supir',
    label: 'SUPIR restore',
    group: 'Restore & upscale',
    description: 'High-quality photo restoration + upscale, optionally prompt-guided (zsxkib/supir).',
    model: 'zsxkib/supir',
    ports: [IMAGE(), PROMPT({ required: false })],
  }),
  makeReplicateNode({
    type: 'nafnet',
    label: 'NAFNet (deblur/denoise)',
    group: 'Restore & upscale',
    description: 'Image deblurring / denoising restoration (megvii-research/nafnet).',
    model: 'megvii-research/nafnet',
    ports: [IMAGE()],
  }),

  // ---- Image → text (captioning / VLM) ----
  makeReplicateNode({
    type: 'blipCaption',
    label: 'Image Caption (BLIP)',
    group: 'Describe',
    description:
      'Lightweight image captioning / VQA (salesforce/blip). Leave the question empty to caption, or ask a question.',
    model: 'salesforce/blip',
    output: 'text',
    ports: [IMAGE(), { id: 'prompt', label: 'Question', type: 'text', key: 'question', required: false }],
  }),
  makeReplicateNode({
    type: 'moondream',
    label: 'Moondream (VLM)',
    group: 'Describe',
    description: 'Small vision-language model — ask a question about the image (lucataco/moondream2).',
    model: 'lucataco/moondream2',
    output: 'text',
    ports: [IMAGE(), { id: 'prompt', label: 'Question', type: 'text', key: 'prompt', required: false }],
  }),
  makeReplicateNode({
    type: 'llava',
    label: 'LLaVA (VLM)',
    group: 'Describe',
    description: 'Larger vision-language model for detailed image Q&A (yorickvp/llava-13b).',
    model: 'yorickvp/llava-13b',
    output: 'text',
    ports: [IMAGE(), { id: 'prompt', label: 'Question', type: 'text', key: 'prompt', required: false }],
  }),
  makeReplicateNode({
    type: 'clipInterrogator',
    label: 'CLIP Interrogator',
    group: 'Describe',
    description: 'Reverse-engineer a text prompt from an image (pharmapsychotic/clip-interrogator).',
    model: 'pharmapsychotic/clip-interrogator',
    output: 'text',
    ports: [IMAGE()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'mode',
          label: 'Mode',
          options: ['best', 'fast', 'classic', 'negative'].map((v) => ({ value: v, label: v })),
        },
        default: 'best',
      },
    ],
  }),
  makeReplicateNode({
    type: 'ocr',
    label: 'OCR (text extract)',
    group: 'Describe',
    description: 'Extract text from an image (abiruyt/text-extract-ocr).',
    model: 'abiruyt/text-extract-ocr',
    output: 'text',
    ports: [IMAGE()],
  }),

  // ---- Custom ----
  makeReplicateNode({
    type: 'replicateCustom',
    label: 'Replicate (custom)',
    group: 'Custom',
    description:
      'Run any Replicate model. Set the slug, wire up to two images/masks + a prompt, and add any other inputs via Extra inputs (JSON).',
    model: '',
    ports: [
      IMAGE({ required: false }),
      { id: 'image2', label: 'Image 2 / mask', type: 'image', key: 'mask', required: false },
      { id: 'prompt', label: 'Prompt', type: 'text', key: 'prompt', required: false },
    ],
  }),
];
