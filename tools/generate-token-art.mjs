#!/usr/bin/env node
/**
 * Token art for the warriors Knight summons.
 *
 *   node tools/generate-token-art.mjs            # everything missing
 *   node tools/generate-token-art.mjs dwarf orc  # just these
 *   node tools/generate-token-art.mjs --force    # redo what exists
 *
 * The compendium has no token art to offer — not one of the sampled martial
 * NPCs has any, the system's own Knight included — so a summoned warrior would
 * arrive as the default silhouette. These are generated instead.
 *
 * Square, because a token is square, and framed as a bust rather than a
 * full figure: a token is displayed small, and a whole armoured body at that
 * size is a smudge. The style matches the card art so the summons looks like
 * it came out of the same deck.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'assets/tokens');
const BASE = (process.env.COMFYUI_BASE_URL || 'https://comfyui.johannsen.cloud').replace(/\/$/, '');
const CHECKPOINT = process.env.COMFYUI_CHECKPOINT || 'sd_xl_base_1.0.safetensors';
const STEPS = parseInt(process.env.COMFYUI_STEPS || '28', 10);
const CFG = parseFloat(process.env.COMFYUI_CFG || '7.0');
const SAMPLER = process.env.COMFYUI_SAMPLER || 'dpmpp_sde';
const SCHEDULER = process.env.COMFYUI_SCHEDULER || 'karras';
export const SIZE = 1024;
export const TOKEN_PX = 512;

// No "aged parchment texture" here, though the card art uses it. On a token it
// invites the model to draw the parchment — the tengu came back on a bordered
// sheet, which reads as a square tile on a map instead of blending into dark
// ground. The background instruction is repeated and placed last, where it
// carries more weight.
export const STYLE = 'dark fantasy illustration, intricate linework, rich jewel-tone colors, '
  + 'dramatic rim lighting, centered bust portrait, isolated on a plain solid black background, '
  + 'black background, no scenery, no backdrop';

export const NEGATIVE = 'text, letters, words, watermark, signature, logo, frame, border, ornate border, '
  + 'parchment, paper texture, scroll, background scenery, landscape, architecture, interior, '
  + 'multiple figures, crowd, full body, tiny figure, blurry, deformed hands, extra limbs, '
  + 'modern clothing, firearms, photograph, 3d render';

/**
 * A style for creatures that have no head to make a bust of.
 *
 * "Centered bust portrait" is right for a warrior and actively wrong for an
 * ooze: asked for living tar, the model produced a woman's face, and asked for
 * a blob it produced a mouth full of teeth. It was obeying the style, not the
 * prompt. The background checker passed all three, because a wrong subject on
 * a clean black field is still a clean black field.
 *
 * The second attempt got the shape right and the setting wrong: the tar came
 * back as a waterfall between canyon walls, which the corner check also passed
 * because the corners were black and the scenery was in the middle. Hence
 * "floating in empty black space" here — a creature with nothing under it
 * cannot be standing in a landscape.
 */
export const SHAPELESS_STYLE = 'dark fantasy illustration, intricate linework, rich jewel-tone colors, '
  + 'dramatic rim lighting, one single creature alone, floating in empty black space with '
  + 'nothing around it, isolated on a plain solid black background, black background, '
  + 'no scenery, no ground, no backdrop';

export const SHAPELESS_NEGATIVE = `${NEGATIVE}, face, head, eyes, mouth, teeth, fangs, portrait, `
  + 'person, humanoid, creature with a face, glass tank, aquarium, jar, container, display case, '
  + 'glass, wireframe, outline box, diagram, cutaway, cliff, canyon, rocks, cave, waterfall, '
  + 'ground, floor, terrain, horizon';

/**
 * A style for the macro icons, which are not tokens and are not drawn big.
 *
 * A hotbar slot is about fifty pixels. Everything the token style asks for —
 * intricate linework, fine detail, a portrait's worth of face — turns to mud
 * at that size, so this asks for the opposite: a few large shapes with a
 * silhouette you can read at a glance, which is what an icon is.
 */
export const ICON_STYLE = 'bold emblematic game icon, one strong simple silhouette, a few large shapes, '
  + 'thick heavy outlines, very high contrast, dramatic rim lighting, painted dark fantasy, '
  + 'the object centred and filling the frame, isolated on a plain solid black background, '
  + 'black background, no scenery';

// The first three came back as gold line-art inside ornate frames, and at
// fifty pixels they were three identical gold circles. "Tarot" invited the
// frame and the gold; naming the ornament explicitly is what keeps it out, and
// each icon carries its own colour so they read apart in the hotbar.
export const ICON_NEGATIVE = `${NEGATIVE}, fine detail, intricate tiny elements, busy composition, `
  + 'thin delicate lines, cluttered, many small objects, realistic photograph, muted colours, '
  + 'card frame, ornamental border, filigree, corner ornament, circular frame, ring border, '
  + 'concentric circles, symmetrical mandala, art deco border, gold line art, engraving';

/**
 * One entry per ancestry we expect to see, plus a fallback.
 *
 * Ordered as the table plays: the party's own ancestries first, then the rest
 * of the Player Core common eight. Each description names the features that
 * actually distinguish the ancestry, because "a dwarf warrior" alone tends to
 * produce a man with a beard whatever you asked for.
 */
export const SUBJECTS = [
  // The party.
  { id: 'dwarf',    who: 'a dwarf warrior, broad and heavily built, long braided beard, deep-set eyes under a heavy brow' },
  { id: 'human',    who: 'a human warrior, weathered and scarred, close-cropped hair' },
  // 'Tengu' pulls Japanese aesthetics hard enough to override the armour, so
  // the plate is named again in the subject rather than left to the suffix.
  { id: 'tengu',    who: 'a tengu warrior in European steel plate armour, a crow-headed humanoid with a long black beak, glossy black feathers, bright bird eyes' },
  // The rest of the Player Core common ancestries.
  { id: 'elf',      who: 'an elf warrior, tall and narrow-featured, long pointed ears, sharp cheekbones, long pale hair' },
  { id: 'gnome',    who: 'a gnome warrior, small and wiry with an oversized head, enormous eyes, wild brightly-coloured hair' },
  { id: 'goblin',   who: 'a goblin warrior, small and green-skinned, enormous pointed ears, wide mouth of sharp teeth, no hair' },
  { id: 'halfling', who: 'a halfling warrior, small and round-cheeked with curly hair and large bare feet, cheerful weathered face' },
  // A leshy is not a green man. Asked for one plainly, the model drew a
  // bearded human face wreathed in leaves inside a heraldic border, which is
  // the folk motif it has far more of. The gourd has to be insisted on and the
  // human face named as something to avoid.
  { id: 'leshy',    who: 'a leshy warrior, a small plant creature whose entire head is a carved wooden gourd with holes cut through it for eyes and mouth, body of bound vines and leaves',
                    avoid: 'human face, beard, moustache, human skin, antlers, laurel wreath, heraldic crest, symmetrical emblem, coat of arms' },
  { id: 'orc',      who: 'an orc warrior, heavy green-grey brow and jutting tusks from the lower jaw, thick corded neck' },
  // Anyone else.
  { id: 'generic',  who: 'an armoured warrior, face shadowed within a closed steel helm' }
];

/**
 * Creatures other cards summon, which the compendium also has no art for.
 * These are not warriors, so they carry their own prompt rather than the
 * plate-and-longsword suffix.
 */
export const CREATURES = [
  { id: 'homunculus', file: 'homunculus',
    prompt: 'A tiny homunculus, a small artificial creature of stitched clay and hammered copper '
      + 'with little leathery bat wings and glowing eyes, perched and alert, looking up at its maker' },
  // Dragon scales with the drawer, so it needs a picture per age band rather
  // than one: a drake at low levels is not an ancient wyrm at high ones.
  // The generic "border" in the negative list was not enough: the drake came
  // back curled inside an ornate ring, which passed the background check
  // because the ring is dark. A roundel is what a small coiled creature
  // invites, so it is ruled out by name.
  { id: 'drake', file: 'dragon-drake',
    prompt: 'A small drake, a lesser dragon the size of a large dog, lean and quick with bright '
      + 'scales and folded leathery wings, head cocked and watchful',
    avoid: 'circular border, ring, roundel, medallion, decorative surround, wreath, '
      + 'coiled into a circle, ouroboros' },
  { id: 'young-dragon', file: 'dragon-young',
    prompt: 'A young dragon, sleek and dangerous with gleaming scales, horned head raised, '
      + 'wings half-furled, coiled and alert' },
  { id: 'elder-dragon', file: 'dragon-elder',
    prompt: 'An ancient dragon, vast and scarred with heavy horns and battered scales, '
      + 'head lowered toward the viewer, ancient and unhurried' },
  // Ooze scales the same way, and none of the system's oozes ship any art at
  // all. "Bust portrait" means nothing for a creature with no head, so these
  // say what shape the thing is instead and let the style carry the rest.
  { id: 'ooze-cube', file: 'ooze-cube', shapeless: true,
    prompt: 'A solid block of translucent green acidic jelly in the shape of a cube, the jelly '
      + 'itself forming every face and edge with nothing holding it, soft and quivering, bones '
      + 'and coins suspended half-dissolved deep inside the green' },
  // A black creature on a black field is a contradiction: four rerolls all
  // came back with the tar on white, because the model needed the contrast
  // somewhere. It is right — a matte black token is a smudge on a dark map —
  // so the tar is given the oil-slick sheen that real tar has, and the colour
  // lives on the creature instead of behind it.
  { id: 'ooze-tar', file: 'ooze-tar', shapeless: true,
    prompt: 'A thick column of living tar rising out of a spreading puddle of itself, heavy and '
      + 'viscous and dripping, its wet black surface shot through with an iridescent oil-slick '
      + 'sheen of violet, teal and gold, lit from the side against darkness' },
  // Skull's avatar is built, not found, so nothing in PF2e depicts it.
  { id: 'avatar-of-death', file: 'avatar-of-death',
    prompt: 'A ghostly humanoid skeleton shrouded in a tattered black robe, its hood empty but '
      + 'for two points of cold light, a scythe held across its shoulder',
    avoid: 'flesh, skin, hair, living face, jack-o-lantern, cartoon' },
  // Monstrosity draws a creature at random and most of them have their own
  // picture; this stands in only where one has none, so it says "something
  // large and wrong" rather than depicting any particular monster.
  { id: 'monstrosity', file: 'monstrosity',
    prompt: 'A huge nameless monster looming forward, heavy hunched shoulders, too many eyes and '
      + 'a mouth of uneven teeth, hide mottled and scarred, wrong in a way that is hard to place',
    avoid: 'recognisable animal, dragon, wings, humanoid, armour, weapon' },
  { id: 'ooze-blob', file: 'ooze-blob', shapeless: true,
    prompt: 'A vast mound of translucent pink and grey devouring slime, veined and pulsing, '
      + 'its leading edge curling forward over itself in a slow breaking wave' }
];

/**
 * Encounter-generator bestiary art (ITEM-2 of docs/backlog.md).
 *
 * The SRD/Monster Core bestiaries ship no token art for most entries, so a
 * randomly-generated encounter mostly spawned the default silhouette. This is
 * a prioritized first batch, not the whole bestiary — see the backlog item
 * for the frequency methodology. Written to their own directory, separate
 * from the hand-picked card-summon art above, since `data/creature-art.json`
 * looks these up by bestiary {pack, docId} rather than by a card's own name.
 *
 * `homunculus` is deliberately absent here — the Monster Core bestiary entry
 * is the same creature the Homunculus card already has art for above, so
 * data/creature-art.json points it at that existing image instead of a
 * second, near-duplicate generation.
 */
export const MONSTER_ART = [
  { id: 'soulrider-fiend', file: 'soulrider-fiend', dir: 'assets/creature-art',
    prompt: 'A reanimated corpse puppeteered from within by a small clawed red fiend nested in '
      + 'its cracked-open ribcage, the corpse’s limbs hanging slack and jerking at odd '
      + 'angles, hollow dead eyes, unnatural posture',
    avoid: 'skeleton, zombie with visible rot, clean armor, living human expression' },
  { id: 'spawning-soulrider-fiend', file: 'spawning-soulrider-fiend', dir: 'assets/creature-art',
    prompt: 'A reanimated corpse riddled with small fiendish growths bursting from its skin, a '
      + 'cluster of tiny red clawed fiends visible at its open chest cavity, limbs slack and '
      + 'puppeted, hollow eyes',
    avoid: 'skeleton, zombie with visible rot, clean armor, living human expression' },
  { id: 'animated-armor', file: 'animated-armor', dir: 'assets/creature-art',
    prompt: 'An empty suit of ornate steel plate armor standing upright with no one inside, the '
      + 'closed visor’s slit glowing faint arcane blue from within, joints faintly wreathed '
      + 'in animating magic',
    avoid: 'person wearing it, visible face, knight, human hands' },
  { id: 'clockwork-spy', file: 'clockwork-spy', dir: 'assets/creature-art', shapeless: true,
    prompt: 'A small brass clockwork construct the size of a cat, a round segmented body '
      + 'standing on six thin jointed insectoid mechanical legs like a spider, one glowing '
      + 'camera-lens eye on a swiveling stalk, thin antenna probes, crouched low and watchful',
    avoid: 'humanoid, robot person, large size, decorative trophy, lamp, urn, pedestal, table, '
      + 'furniture, no legs visible, moon, pale circle, yellow circle, circular halo, circular '
      + 'backdrop, sun, glowing disc' },
  { id: 'wolf-skeleton', file: 'wolf-skeleton', dir: 'assets/creature-art',
    prompt: 'A skeletal wolf, bare bone and a bared fanged skull, faint unholy violet light '
      + 'glowing in its empty eye sockets, hackles of nothing but exposed rib',
    avoid: 'fur, flesh, living wolf' },
  { id: 'ghoul-stalker', file: 'ghoul-stalker', dir: 'assets/creature-art',
    prompt: 'A crouched ghoul with grey rotting flesh stretched over long clawed hands, an '
      + 'elongated fanged jaw, feral hunting stance, hungry red eyes',
    avoid: 'circular halo, glowing ring, moon, full moon, circular border, vignette circle, '
      + 'medallion, disc behind head' },
  { id: 'draugr', file: 'draugr', dir: 'assets/creature-art',
    prompt: 'A frost-rimed undead warrior in ancient corroded mail, matted hair over a frozen '
      + 'blue-grey face split in a silent snarl, glowing cold pale eyes' },
  { id: 'fire-wisp', file: 'fire-wisp', dir: 'assets/creature-art', shapeless: true,
    prompt: 'A small drifting orb of living flame with a flickering white-hot inner core, '
      + 'tendrils of fire trailing like hair, casting no shadow, alone in darkness' },
  { id: 'icicle-snake', file: 'icicle-snake', dir: 'assets/creature-art',
    prompt: 'A serpent of translucent blue ice, its coiled body faceted like carved crystal, '
      + 'faint frost mist trailing from its fanged jaws, glowing pale eyes' },
  { id: 'grindylow', file: 'grindylow', dir: 'assets/creature-art',
    prompt: 'A small hunched aberration with slick green-grey amphibious skin, huge bulging '
      + 'black eyes, webbed clawed hands, a wide lipless mouth of needle teeth, floating alone '
      + 'against a background that is solid black with nothing else in it',
    avoid: 'green background, colored background, tinted background, spotlight, vignette' },
  { id: 'reefclaw', file: 'reefclaw', dir: 'assets/creature-art',
    prompt: 'A crustacean-like aberration with a hard chitinous grey-blue shell, one oversized '
      + 'crushing claw raised, small stalked black eyes, dripping with brine' },
  { id: 'imp', file: 'imp', dir: 'assets/creature-art',
    prompt: 'A small red-skinned devil with leathery bat wings, a barbed tail, sharp horns and '
      + 'a wicked fanged grin, claws poised',
    avoid: 'cute cartoon, human face' },
  { id: 'ort', file: 'ort', dir: 'assets/creature-art', shapeless: true,
    prompt: 'A writhing mass of tiny screeching devil-faces and grasping clawed hands fused '
      + 'together into one gelatinous crawling shape, mindless and hungry',
    avoid: 'single humanoid, single face' },
  // A leshy is not a green man — see the leshy warrior's own note above. The
  // first pass drew a human face wreathed in leaves and a pale backdrop, so
  // both failures are named explicitly here.
  { id: 'leaf-leshy', file: 'leaf-leshy', dir: 'assets/creature-art',
    prompt: 'A small plant creature with no human skin anywhere, its entire head formed from '
      + 'overlapping broad green leaves with two small glowing seed-pod eyes and no other '
      + 'facial features, twig-like limbs, bark-textured torso, alone on a plain solid black '
      + 'background',
    avoid: 'human face, human skin, beard, moustache, antlers, laurel wreath, heraldic crest, '
      + 'symmetrical emblem, coat of arms, pale background, white background, light background' },
  { id: 'sprigjack', file: 'sprigjack', dir: 'assets/creature-art',
    prompt: 'A single gangly fey plant creature standing alone, a spindly woven-twig body and '
      + 'one oversized grinning wooden jack-o-lantern-shaped pumpkin head with a jagged carved '
      + 'grin, thorny fingers, mischievous stance, isolated with nothing else in the frame',
    avoid: 'multiple pumpkins, group of pumpkins, halloween scene, decorative border, vine '
      + 'border, corner ornament, hanging ornaments, other creatures, jewelry' },
  { id: 'carbuncle', file: 'carbuncle', dir: 'assets/creature-art',
    prompt: 'A small fox-like beast with a glowing red gemstone embedded in its forehead, sleek '
      + 'fur, alert pointed ears, watchful intelligent eyes' },
  { id: 'kappa', file: 'kappa', dir: 'assets/creature-art',
    prompt: 'A crouched humanoid turtle-beast standing upright on two legs, a hard shell on its '
      + 'back, a clearly visible shallow bowl-shaped dish full of water set into the top of its '
      + 'head, webbed clawed humanoid hands, a beaked turtle mouth, richly colored green-grey '
      + 'scaled skin, alone against a background that is solid black with nothing else in it',
    avoid: 'green background, colored background, tinted background, spotlight, vignette, '
      + 'plain animal turtle, quadruped, grayscale, monochrome, black and white, line art, '
      + 'water pool, reflection, wet ground, standing in water' },
  // Echoes the existing 'drake' entry's framing and failure mode (a small
  // coiled creature invites a circular border/roundel) — same avoid list,
  // plus an explicit reptile-not-bird correction after the first pass drew a
  // parrot: 'drake' alone was not enough to keep the model off a bird.
  { id: 'house-drake', file: 'house-drake', dir: 'assets/creature-art',
    prompt: 'A tiny reptilian dragon the size of a housecat, a scaled dragon body (not a bird), '
      + 'lean and quick with glossy small scales, clawed feet, and stubby leathery bat-like '
      + 'wings, perched and alert, head cocked curiously',
    avoid: 'bird, beak, feathers, parrot, avian, plumage, circular border, ring, roundel, '
      + 'medallion, decorative surround, wreath, coiled into a circle, ouroboros' },
  { id: 'fey-dragonet', file: 'fey-dragonet', dir: 'assets/creature-art',
    prompt: 'A tiny fey dragon no larger than a bird, delicate iridescent scales and gossamer '
      + 'dragonfly-like wings, large luminous eyes, perched daintily',
    avoid: 'circular border, ring, roundel, medallion, decorative surround, wreath, '
      + 'coiled into a circle, ouroboros' },

  // ITEM-18 batch 1 (docs/backlog.md) — the first 20 of 1,609 remaining
  // core-bestiary creatures, lowest level and least rare first
  // (docs/creature-art-todo.csv). All level -1, all common.
  { id: 'adept', file: 'adept', dir: 'assets/creature-art',
    prompt: 'A human occult adept in plain hooded robes, holding a small glowing sigil-carved '
      + 'talisman close to the chest, watchful eyes catching a faint arcane glow, quiet and '
      + 'unassuming',
    avoid: 'circular halo, moon, full moon, circular border, starry background, stars, '
      + 'constellation, glowing ring, mystical circle behind subject, arch, archway, doorway, '
      + 'window, gothic frame, portal, stained glass' },
  { id: 'animated-broom', file: 'animated-broom', dir: 'assets/creature-art', shapeless: true,
    prompt: 'An ordinary wooden broom animated by household magic, its handle upright and '
      + 'frayed straw bristles raised defensively like a weapon, faint magical shimmer along '
      + 'the wood, floating with no one holding it',
    avoid: 'person holding it, witch, cartoon, cute face, googly eyes' },
  { id: 'apothecary', file: 'apothecary', dir: 'assets/creature-art',
    prompt: 'A human apothecary in a stained leather apron over plain robes, holding a small '
      + 'corked glass vial of glowing green tincture up to the light, worn hands, a bundle of '
      + 'dried herbs at the belt' },
  { id: 'apprentice', file: 'apprentice', dir: 'assets/creature-art',
    prompt: 'A young human apprentice cartographer in simple travel-worn clothes, a leather '
      + 'satchel of scrolls and a rolled map tube slung across the back, ink-stained fingers, '
      + 'eager watchful expression' },
  { id: 'barrister', file: 'barrister', dir: 'assets/creature-art',
    prompt: 'A human barrister in formal dark robes with a stiff white collar, an ornate '
      + 'wax-sealed scroll of legal parchment held in one hand, sharp calculating eyes, '
      + 'groomed and composed',
    avoid: 'circular halo, moon, full moon, circular border, glowing ring, white circle, '
      + 'pale disc behind subject' },
  { id: 'beggar', file: 'beggar', dir: 'assets/creature-art',
    prompt: 'A gaunt human beggar in ragged patched clothes, a chipped wooden begging bowl '
      + 'cupped in thin hands, hollow watchful eyes, matted hair, worn down by hard years on '
      + 'the street, full color illustration',
    avoid: 'black and white, monochrome, grayscale, line art, woodcut, engraving, ornate '
      + 'circular border, decorative border, medallion, coin, frame, sepia' },
  // Bloodseeker is PF2e's stirge — a mosquito-like blood drinker, not a bat
  // or spider despite the "seeker" name inviting either.
  { id: 'bloodseeker', file: 'bloodseeker', dir: 'assets/creature-art', shapeless: true,
    prompt: 'A tiny blood-drinking swamp creature resembling a monstrous mosquito, a long '
      + 'needle-like proboscis extended forward, thin leathery wings, a swollen abdomen, '
      + 'floating alone with nothing around it',
    avoid: 'humanoid, bat, spider, cute, cartoon, ground, floor, horizon, water, reflection, '
      + 'gradient background, fog, mist, swamp scenery, landscape' },
  { id: 'common-eurypterid', file: 'common-eurypterid', dir: 'assets/creature-art',
    prompt: 'A large aquatic arthropod resembling an armored sea scorpion, segmented '
      + 'chitinous plates, several jointed legs, a pair of large pincer-claws raised, a '
      + 'paddle-like tail, wet glistening carapace',
    avoid: 'crab, lobster, humanoid, land animal, dry ground' },
  { id: 'commoner', file: 'commoner', dir: 'assets/creature-art',
    prompt: 'A weary human commoner in coarse homespun clothes, calloused hands resting on a '
      + 'simple wooden tool, a plain undyed tunic, tired resigned expression, full color '
      + 'illustration',
    avoid: 'black and white, monochrome, grayscale, line art, woodcut, engraving, ornate '
      + 'circular border, decorative border, medallion, coin, frame, sepia' },
  { id: 'compsognathus', file: 'compsognathus', dir: 'assets/creature-art',
    prompt: 'A small swift bipedal dinosaur the size of a chicken, sleek scaled hide, sharp '
      + 'darting eyes, jaws parted baring tiny venomous teeth, poised mid-dart',
    avoid: 'large dinosaur, t-rex scale, cartoon, feathers like a bird, cute' },
  { id: 'court-historian', file: 'court-historian', dir: 'assets/creature-art',
    prompt: 'A human court historian in fine ink-stained scholarly robes, an open '
      + 'leather-bound tome cradled in one arm, a quill tucked behind the ear, sharp '
      + 'observant eyes missing nothing',
    avoid: 'circular halo, moon, full moon, circular border, glowing ring, white circle, '
      + 'pale disc behind subject' },
  { id: 'crawling-hand', file: 'crawling-hand', dir: 'assets/creature-art', shapeless: true,
    prompt: 'Extreme close-up of a single severed ordinary human hand only, nothing else in '
      + 'the frame, pale grey rotting undead flesh, a jagged stump of bone at the wrist, '
      + 'blunt human fingernails, crooked human fingers curled inward, faint sickly green '
      + 'necrotic glow, floating alone in plain empty black space',
    avoid: 'full body, forearm, arm, wrist guard, armor, full skeleton, face, demon hand, '
      + 'monster claws, purple skin, reptilian skin, long claw-like fingernails, talons, '
      + 'clean skin, healthy skin, spider, insect, moon, full moon, forest, trees, '
      + 'landscape, scenery, night sky, stars, other creatures, animal' },
  { id: 'eagle', file: 'eagle', dir: 'assets/creature-art',
    prompt: 'A great bird of prey with golden-brown plumage, a sharp hooked beak, fierce '
      + 'piercing eyes, powerful talons extended, wings half-spread as if landing',
    avoid: 'cartoon, cute, human, songbird' },
  { id: 'flash-beetle', file: 'flash-beetle', dir: 'assets/creature-art',
    prompt: 'A three-foot-long armored beetle with a pair of glowing bioluminescent organs on '
      + 'its abdomen casting soft light, a thick chitinous shell, mandibles raised, antennae '
      + 'alert',
    avoid: 'cute, cartoon, ladybug pattern, firefly, humanoid' },
  { id: 'giant-centipede', file: 'giant-centipede', dir: 'assets/creature-art',
    prompt: 'A giant segmented centipede, glossy chitinous plates, dozens of clawed legs '
      + 'rippling along its length, curved venomous mandibles bared, coiled and aggressive',
    avoid: 'cute, cartoon, snake, worm, no legs' },
  { id: 'giant-rat', file: 'giant-rat', dir: 'assets/creature-art',
    prompt: 'An oversized filthy sewer rat the size of a large dog, matted mangy fur, bared '
      + 'yellow incisors, beady red eyes, a long scarred tail, hunched and feral',
    avoid: 'cute, cartoon, pet, clean fur, mouse' },
  { id: 'gnome-philomath', file: 'gnome-philomath', dir: 'assets/creature-art',
    prompt: 'A gnome philomath, small and wiry with an oversized head, enormous curious eyes '
      + 'and wild brightly-colored hair, surrounded by loose pages tucked into their coat, a '
      + 'magnifying lens held up, sharp inquisitive expression, full color illustration, '
      + 'isolated on a plain solid black background with nothing else in it',
    avoid: 'black and white, monochrome, grayscale, line art, woodcut, engraving, sepia, '
      + 'teal background, green background, mint background, colored background, tinted '
      + 'background, solid color background, studio backdrop' },
  { id: 'goblin-warrior', file: 'goblin-warrior', dir: 'assets/creature-art',
    prompt: 'A goblin warrior, small with green-grey mottled skin, an oversized head and wide '
      + 'pointed ears, jagged crude armor scraps, a notched blade held ready, wide grin of '
      + 'sharp teeth' },
  { id: 'grimple', file: 'grimple', dir: 'assets/creature-art', shapeless: true,
    prompt: 'A tiny malicious fey gremlin, wiry grey-green skin, oversized bat-like ears, a '
      + 'mischievous gap-toothed grin, clawed fingers caught mid-prank, crouched and gleeful '
      + 'in darkness',
    avoid: 'cute, goblin, humanoid child, fairy wings, pixie' },
  { id: 'guard-dog', file: 'guard-dog', dir: 'assets/creature-art',
    prompt: 'A sturdy alert guard dog, short bristling fur, ears pricked forward, teeth bared '
      + 'in a low warning snarl, a muscular stance, a plain leather collar',
    avoid: 'cute, puppy, cartoon, wagging tail, friendly, circular border, ring, roundel, '
      + 'medallion, decorative surround, wreath, coiled into a circle, ouroboros, chain '
      + 'border, spiked ring' }
];

/**
 * The macro icons the module installs onto the hotbar.
 *
 * They ship pointing at Foundry's own card-hand, eye and regen SVGs, which are
 * flat grey line drawings and look like nothing to do with this deck. Three
 * shapes that read apart at a glance: a fan of cards, an eye, a spiral.
 */
export const ICONS = [
  // A single card filling the frame is a framed picture, which is why this
  // kept coming back bordered. The cards have to overlap and tilt to read as
  // a hand rather than as a portrait of one card.
  { id: 'icon-deck', file: 'macro-deck', dir: 'assets/icons', icon: true,
    prompt: 'Four playing cards fanned out at sharply different angles like a hand held in the '
      + 'fingers, overlapping each other, deep crimson backs edged in gold, tilted diagonally '
      + 'across the picture',
    avoid: 'single card, one card upright, framed picture, picture frame, heart symbol, '
      + 'poker card face, suits, numbers' },
  { id: 'icon-divine', file: 'macro-divine', dir: 'assets/icons', icon: true,
    prompt: 'One single huge open eye, a glowing violet iris pouring pale light, nothing else' },
  { id: 'icon-reset', file: 'macro-reset', dir: 'assets/icons', icon: true,
    prompt: 'Two thick emerald green arrows curving around each other into a closed circle, '
      + 'a small squat stack of cards resting in the middle' }
];

const promptFor = (s) => s.prompt
  ? `${s.prompt}, ${s.icon ? ICON_STYLE : s.shapeless ? SHAPELESS_STYLE : STYLE}`
  : `Portrait bust of ${s.who}, wearing full plate armour, `
    + `a longsword held upright at the shoulder, stern and watchful, sworn to service, ${STYLE}`;

const negativeFor = (s) => {
  const base = s.icon ? ICON_NEGATIVE : s.shapeless ? SHAPELESS_NEGATIVE : NEGATIVE;
  return s.avoid ? `${base}, ${s.avoid}` : base;
};

/** Every subject, warriors and creatures alike, with the file each writes. */
const ALL = [
  ...SUBJECTS.map((s) => ({ ...s, file: `warrior-${s.id}` })),
  ...CREATURES.map((c) => ({ ...c, file: c.file })),
  ...MONSTER_ART,
  ...ICONS
];

/** Tokens go to assets/tokens; a subject may name somewhere else. */
const dirFor = (s) => (s.dir ? join(root, s.dir) : OUT_DIR);

const build = (prompt, seed, prefix, negative = NEGATIVE) => ({
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
  '4': { class_type: 'EmptyLatentImage', inputs: { width: SIZE, height: SIZE, batch_size: 1 } },
  '5': { class_type: 'KSampler',
         inputs: { seed, steps: STEPS, cfg: CFG, sampler_name: SAMPLER, scheduler: SCHEDULER,
                   denoise: 1.0, model: ['1', 0], positive: ['2', 0], negative: ['3', 0],
                   latent_image: ['4', 0] } },
  '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
  '7': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['6', 0] } }
});

async function enqueue(workflow) {
  const res = await fetch(`${BASE}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'dommt-token-' + Math.random().toString(36).slice(2, 8) })
  });
  if (!res.ok) throw new Error(`enqueue failed: ${res.status} ${await res.text()}`);
  return (await res.json()).prompt_id;
}

async function waitFor(promptId, { timeoutMs = 420_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/history/${promptId}`);
    if (res.ok) {
      const entry = (await res.json())[promptId];
      const images = Object.values(entry?.outputs ?? {}).flatMap((o) => o.images ?? []);
      if (images.length) return images[0];
      if (entry?.status?.status_str === 'error') throw new Error('generation failed');
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

async function fetchImage({ filename, subfolder = '', type = 'output' }) {
  const url = `${BASE}/view?filename=${encodeURIComponent(filename)}`
    + `&subfolder=${encodeURIComponent(subfolder)}&type=${type}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * How much background an image has, as one number to reroll against.
 *
 * This measured the four corners until the oozes got past it three times over:
 * a canyon with black sky in the corners, then a white halo with the corners
 * still black. It now matches tools/check-token-art.mjs — a ring right round
 * the outside, and a penalty for pale pixels anywhere — so the generator stops
 * keeping images the checker will reject afterwards.
 */
function backgroundScore(path) {
  const py = join(root, '.venv/bin/python3');
  const script = `
from PIL import Image
import sys
import numpy as np
a = np.asarray(Image.open(sys.argv[1]).convert('L'), dtype=float)
h, w = a.shape
r = max(1, int(min(w, h) * 0.10))
ring = np.concatenate([a[:r,:].ravel(), a[-r:,:].ravel(), a[:,:r].ravel(), a[:,-r:].ravel()])
bright = (a > 200).mean() * 100
# A pale backdrop is worth as much as a bright edge; the worse fault wins.
print(max(ring.mean(), bright * 2.5))
`;
  try {
    return parseFloat(execFileSync(py, ['-c', script, path], { encoding: 'utf8' }).trim());
  } catch {
    return null;                       // no Pillow: accept whatever came back
  }
}

/** Store at token size, not generation size. */
function shrink(src, dest) {
  const py = join(root, '.venv/bin/python3');
  const script = `
from PIL import Image
import sys
Image.open(sys.argv[1]).convert('RGB').resize((512, 512), Image.LANCZOS) \
  .save(sys.argv[2], 'WEBP', quality=88, method=6)
`;
  try { execFileSync(py, ['-c', script, src, dest]); }
  catch { writeFileSync(dest, readFileSync(src)); }   // no Pillow: keep the png bytes
}

const CLEAN_THRESHOLD = 45;      // stay under the checker's 50
const MAX_ATTEMPTS = 4;

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const reroll = parseInt(args.find((a) => a.startsWith('--reroll='))?.split('=')[1] ?? '0', 10);
  const only = args.filter((a) => !a.startsWith('--'));
  const wanted = ALL.filter((s) => (!only.length || only.includes(s.id)));
  for (const s of wanted) {
    const outDir = dirFor(s);
    mkdirSync(outDir, { recursive: true });
    const dest = join(outDir, `${s.file}.png`);
    const final = join(outDir, `${s.file}.webp`);
    if (existsSync(final) && !force) { console.log(`${s.id.padEnd(10)} exists, skipping`); continue; }
    const prompt = promptFor(s);
    // The same prompt produces a plain background on some rolls and a lit
    // interior on others, so this rerolls rather than accepting the first
    // answer. The seed is derived from the ancestry and the attempt, so a
    // rerun reproduces the same sequence.
    const base = ([...s.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)
      + reroll * 104_729) % 2_000_000_000;
    let best = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      process.stdout.write(`${s.id.padEnd(10)} attempt ${attempt + 1}… `);
      const id = await enqueue(build(prompt, (base + attempt * 7919) % 2_000_000_000,
                                     `dommt-token-${s.id}`, negativeFor(s)));
      writeFileSync(dest, await fetchImage(await waitFor(id)));
      const score = backgroundScore(dest);
      if (score === null) { console.log('(unmeasured) kept'); best = { score: 0 }; break; }
      console.log(`background ${score.toFixed(0)}`);
      if (!best || score < best.score) {
        best = { score, buf: null };
        writeFileSync(join(outDir, `.best-${s.file}.png`), readFileSync(dest));
      }
      if (score < CLEAN_THRESHOLD) break;
    }
    // Keep the darkest of the attempts if none came back clean.
    const bestPath = join(outDir, `.best-${s.file}.png`);
    if (existsSync(bestPath)) {
      writeFileSync(dest, readFileSync(bestPath));
      unlinkSync(bestPath);
    }
    const kept = backgroundScore(dest);
    // ComfyUI returns a 1024 png; a token is drawn at a couple of hundred
    // pixels, so it is stored at 512 as webp — 1.5 MB becomes about 50 KB.
    shrink(dest, final);
    unlinkSync(dest);
    console.log(`${' '.repeat(10)} kept background ${kept === null ? '?' : kept.toFixed(0)}`
      + ` -> ${s.dir ?? 'assets/tokens'}/${s.file}.webp`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
