#!/usr/bin/env node
/**
 * Rewrite every card's art prompt on the hybrid direction:
 * the scene comes from the card's `flavor` (the illustration printed in the
 * hardcopy book), the card's mechanic appears as mood or a secondary detail.
 *
 * Background: the original prompts were authored from `mechanics.kind` alone,
 * so the art depicted game effects rather than the printed scenes — 30 of 66
 * conflicted outright with their flavor text (docs/prompt-flavor-audit.md).
 *
 * Prompts ask for NO frame and NO card name. Both are composited afterwards by
 * tools/compose-cards.mjs, which reads the name from cards.json. Every attempt
 * to prompt for either failed: "Tarot card:" and later "Ornate framed card
 * illustration:" both put a card-noun in title position and produced gibberish
 * label cartouches (12 of 66 on the last run), while "ornate gold border" among
 * the style tags was absorbed into the subject rather than framing it.
 *
 * Usage:
 *   node tools/rewrite-prompts-hybrid.mjs --dry-run
 *   node tools/rewrite-prompts-hybrid.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const cardsPath = resolve(root, 'data/cards.json');
const dry = process.argv.includes('--dry-run');

// No framing language, by design. The decorative border is composited on
// afterwards (tools/compose-cards.mjs) exactly like the name plate, because
// asking the model for one fails two ways: a "card illustration" prefix puts a
// card-noun in title position and a gibberish label cartouche comes back, and
// "ornate gold border" among the style tags gets absorbed into the subject —
// it became a glass tank on Ooze, a hung picture frame on Staff, and the
// building's own facade on Temple. Art is generated full-bleed; the frame and
// plate go on top. `frame` and `border` are suppressed in the negative prompt
// in tools/generate-art.mjs so the model's own does not clash with ours.
const PREFIX = '';
const SUFFIX = ', dark fantasy illustration, aged parchment texture, intricate linework, ' +
  'rich jewel-tone colors, vertical portrait orientation, full bleed composition';

// id -> scene. Flavor supplies the subject; the mechanic supplies the mood,
// usually as the clause after the semicolon.
const SCENES = {
  aberration: 'A cluttered alchemical laboratory, glassware and instruments strewn across the benches; hovering above them floats a single enormous eyeball creature — one huge central eye set in a round fleshy orb, a wide fanged mouth beneath it, and many long thin stalks rising from its crown each tipped with its own small eye; faint concentric ripples of thought spread outward through the air',
  // The 'sliding along the beam, trading places' idea was too abstract to
  // read as an image. Simplified to one legible composition, detail pushed up.
  balance: 'A tall ornate set of golden balance scales standing on a carved stone pedestal, the metalwork richly engraved with fine filigree and worn detail; in the left pan rests a small blazing golden sun, in the right pan a silver crescent moon lying in a pool of night; the beam hangs level and the two lights face each other across it',
  beast: 'A snarling wolf-like predator at the centre of a dark wood, hackles raised and teeth bared, its eyes uncomfortably human; behind it hangs the faint overlaid silhouette of the person it was, caught mid-change',
  book: 'An enormous leather-bound book lying open among scattered scrolls and loose parchment, a quill and ink pot at its edge; the visible pages carry layered scripts of many different alphabets, each lifting faintly off the page as coloured light',
  bridge: 'A weathered stone bridge arcing across dark water, a shadowed shape crouched beneath its span with only two gleaming eyes visible; the water is frozen mid-ripple and a falling leaf hangs motionless in the air, time held still',
  campfire: 'A large campfire burning steadily in deep night, a bedroll and travelling pack set at its edge, warm light pushing back a wide circle of darkness; the surrounding night is utterly quiet and safe',
  cavern: 'A vast underground cavern lit by clusters of glowing fungi, striking stone columns and flowstone formations rising through the dark; far across the chamber a small figure ascends a sheer wall, moving up the bare rock with unnatural ease',
  // Reverted: describing the couatl was worse than naming it. Like `kenku`,
  // the model knows this creature — the describe-don't-name rule only holds
  // for the ones actually proven unknown (beholder, gelatinous cube, owlbear).
  celestial: 'A beautiful feathered serpent, a couatl with rainbow plumage, twining in a slow coil through sunlit cloudbanks high above the world; the air beneath it glows with lift and the whole scene feels weightless',
  comet: 'A comet with an enormous blazing tail tearing across a winter night sky, outshining every star around it; far below on a moonlit snowfield a single small figure stands alone over a great fallen shape',
  construct: 'A rigidly geometric clockwork automaton — a perfect cube of brass and enamel with a single large round eye on its front face and small jointed mechanical arms and legs — gripping a wrench inside the interior of a vast clockwork machine, gears and turning shafts receding in every direction; on the bench beside it a small half-built artificial creature of stitched clay and copper with little leathery wings has just begun to stir',
  corpse: 'An adventurer lying dead in a narrow dungeon hallway, pierced by several arrows, their pack spilled across the flagstones; the corridor is cold and utterly still, the moment of collapse only just past',
  crossroads: 'A weathered wooden signpost at a lonely crossroads, its arms pointing many directions at once; the roads leading away age differently, one green with spring growth and another buried under dead leaves, time running at a different rate down each',
  // First fix bound the bars to the stairs; the correction over-suppressed and
  // removed them altogether. The barred gate is now the dominant subject and
  // the negative no longer contains the word 'bars'.
  // Third attempt. First bound the bars to the stairs; second suppressed the
  // bars entirely; third made the gate dominate and lost the stairs and walls.
  // All three elements are now named with their spatial relationship stated.
  donjon: 'A dim underground stone chamber with rough-hewn stone walls rising on both the left and the right, and a short flight of worn stone steps in the foreground descending away from the viewer down to the bottom of the chamber, where a heavy locked iron gate of thick vertical iron bars is set into a stone archway in the far wall; guttering torchlight on the stone walls; through the gaps between the iron bars there is no cell but an empty grey void with no floor and no sky',
  door: 'A large iron-banded wooden door barring a stone passage, set solid in the surrounding stonework; a thin seam of otherworldly light leaks around its edges, another place pressing against it from the far side',
  dragon: 'A menacing red dragon perched atop a vast heaped hoard of gold and treasure deep inside a cave, wings mantled and eyes burning; among the coins near its claws lies a single cracked egg, something small and newly hatched uncurling from it',
  elemental: 'A squat radially symmetrical rock creature with three thick stubby legs, three long arms spaced evenly around its barrel-shaped stone body, three large eyes on its sides and a wide mouth on the top of its head, its hide rough grey mineral, feeding on a vein of raw ore in a cramped underground cavern; the stone parts around its body like water and ribbons of fire, frost and lightning wash over its hide without leaving a mark',
  euryale: 'A medusa with a long serpentine tail in place of legs, coiled among growing flowers and herbs, her hair a mass of small snakes; her gaze falls just past the viewer, and the plants nearest her have gone grey and stiff',
  expert: 'A bard playing a stringed instrument with complete absorption, fingers exact on the strings, a small attentive audience half-lit around them; the air about the instrument glows faintly, practised skill made visible',
  // Count is stated three ways. Plain "three robed sisters" returned seven
  // figures; naming a distinct robe colour per sister returned only two and
  // wrecked the style (flat, garish). This wording is the best of the three.
  fates: 'A trio of exactly three robed sisters, three women only, seated together at one great wooden loom: the first weaving, the second measuring a thread against a rod, the third holding open a pair of shears; a single cut thread drifts loose and unravels backwards into nothing',
  // "half-faded and translucent" did not render — partial transparency is
  // unreliable. The vanishing is now a concrete particle effect instead:
  // solid front half, hindquarters breaking into drifting motes of light.
  fey: 'A lean wolf-like dog with a tawny golden-brown coat and large upright ears leaping through wild undergrowth, its head and forelegs solid and sharply painted while its hindquarters and tail break apart into a streaming trail of drifting blue-white sparks and glowing motes that scatter into the air behind it, the animal vanishing mid-leap; the forest ahead of it shifts into impossible saturated colour through the gap it leaves behind',
  fiend: 'An enormous winged demon with deep red skin and vast leathery bat wings, a horned bull-like head, wreathed in flame and shadow, a burning sword in one hand and a many-tailed flaming whip in the other, striking upward out of an abyssal chasm; a thin scroll of glowing red script hangs in the air before it, a bargain offered mid-violence',
  flames: 'A gaunt humanoid devil whose body is wrapped and pierced by animated barbed iron chains that coil and lash outward on their own, hooks and blades at their ends, wreathed in fire and glaring directly out of the scene with fixed personal hatred; the flames behind it suggest the shape of a face it will not forget',
  fool: 'A cheerful traveller strolling down a country path with their gaze on the horizon, unaware of the coins and small possessions falling one by one from an open pack behind them; the dropped things dim as they land',
  // "a gemstone resting on dark velvet" is a jewellery product-photo staging,
  // which is why anti-photo negatives could not win. Moved into a scene.
  gem: 'A painted illustration with visible brushwork of a single huge faceted gemstone cradled in an intricate gold filigree setting, sitting among worn carved stonework in a dim vaulted chamber, lit from deep within so its coloured light spills across the carvings and shadows around it; the glow it throws is far richer than the stone alone should give',
  giant: 'A hungry troll hunched in a forest clearing, long-limbed and gaunt, sniffing the air; it is already too large for the clearing, branches bending around its shoulders as its scale visibly increases',
  humanoid: 'A pack of small kobolds working together to set an elaborate deadfall trap in their cramped cave lair, one holding a lantern while another ties off the trigger cord; one looks up and raises a flat hand in warning, go no further',
  jester: 'A grinning figure in jester’s motley resting one boot on a bare skull, a belled staff in the crook of an arm; a fan of face-down cards is spread in the other hand, more of them than there ought to be',
  key: 'A large antique metal key of bizarrely elaborate construction hanging point-down in still air, its bow a knot of interlocking wards and its bit a maze of teeth; its edge catches the light like a blade',
  // "hilt-first" confused the sword's orientation and produced a blade with two
  // ends; it now rests flat across both hands. Detail pushed up because the
  // folded-card construction rendered flat and simplistic.
  // Read as a photoreal suit of armour made of construction paper: the cards
  // need to look like *cards* (gilt, printed, coloured), and the medium has to
  // be stated first or 'armour' pulls it photographic.
  knight: 'A painted fantasy illustration with visible brushwork, showing a life-size knight figure built entirely from hundreds of ornate playing cards folded and layered over each other like armour plates, every card showing gilt edges and rich printed colour patterning so the whole figure gleams with jewel-toned card faces rather than plain paper; it stands steady in a posture of offered service, holding out one single sword also built from layered cards, resting flat across both of its open hands',
  // No 'dragon' (it put scales on an inserted figure), no 'knightly' or
  // 'jousting' (both summon a rider). Described purely as an object on a rack.
  // "among plainer spears and blades" produced five near-identical polearms in
  // a row. The other weapons are now named as deliberately different types so
  // the rack reads as a rack and the ornate one stands out against them.
  // Simplified to ONE object. Listing companion weapons produced five identical
  // polearms, then nonsense weapons — the model cannot hold a varied set of
  // objects here. The lance carries the card alone, made ornate and magical.
  // Single-object framing worked; the ornamentation did not — gold filigree and
  // gemstones read as a sceptre, not a lance. Now described by its actual shape
  // (long tapering shaft, steel point, conical hand guard) with the magic shown
  // as a glow rather than encrustation, and leaning into a plain wooden stand.
  lance: 'A painted fantasy illustration of one single long cavalry lance leaning at an angle into a simple plain wooden weapon stand on a stone floor against a bare wall. The lance is a long straight tapering wooden shaft, taller than a person, with a sharp narrow steel point at its upper end and a wide conical steel hand guard near the lower grip, the shaft banded with plain silver rings; it gives off a soft magical glow that lights the wooden stand and the wall behind it. The lance and its wooden stand are the only objects in the picture and nobody is present',
  mage: 'A warlock holding a staff of black crystal upright, robes still, expression composed and inward; the crystal’s interior is lit with slow-moving light and faint diagrams resolve in the air about their head',
  map: 'An elaborate hand-drawn treasure map unrolled and weighted at its corners, coastlines and mountains inked in fine detail; a single marked cross burns with warm golden light while the rest of the parchment dims',
  maze: 'A vast impossible labyrinth seen from high above, its towering walls built entirely from hundreds of enormous playing cards standing on edge, winding corridors folding back on themselves with no exit anywhere; tiny weary figures far below wander between the card walls with their heads down',
  // Same trap as `staff`: the prompt said "a miner's pick", so the subject noun
  // itself was summoning the person that (miner:1.5) was trying to remove.
  // No mine / miner / mining anywhere — described as a cave with a tool in it.
  // The lantern took over the composition and the pickaxe vanished. Same fix as
  // `lance`: one subject only. Lantern removed — the ore glow lights the scene.
  mine: 'A painted fantasy illustration of a single heavy iron pickaxe with a worn wooden handle, propped alone against rough rock at the mouth of a dark cave tunnel, the pickaxe large and central and the only object in the picture; behind it the tunnel recedes into darkness, and a faint warm gleam of raw gemstones and veins of metal ore embedded in the cave wall lights the rock around it; nobody present',
  // "Owlbear" is unknown to the model — it rendered a plain owl. Described.
  // Naming the creature gave a plain owl; then (owl:1.4),(bird:1.4) in the
  // negative killed the owl half and gave a plain bear. The negative now
  // pushes against the BEAR head instead, leaving the owl head unopposed.
  // Attempt 4. This oscillates: naming it gave an owl, suppressing owl gave a
  // bear, suppressing the bear head gave an owl again — the model picks one
  // animal rather than blending. Both halves are now weighted in the positive
  // and BOTH failure modes suppressed, rather than pushing against one side.
  // Attempt 5. Naming either animal lets the model resolve to that animal —
  // owl, then bear, then owl, then bear. No animal names appear now, in the
  // prompt or the negative: the anatomy is described part by part, and the
  // negative is purely anatomical (furred head / wings / feathered torso).
  // Attempt 6. Anatomy-only wording stopped the owl/bear flip but the
  // proportions drifted long-necked and long-tailed. Body proportions are now
  // constrained explicitly: short thick neck, hunched compact bulk, stub tail.
  // Attempt 7. Body proportions are right; only the face reverts to a muzzle.
  // The beak is now weighted and described as replacing the whole muzzle, and
  // the parts that make up a muzzle (nose, mouth, facial fur) are suppressed.
  monstrosity: 'A painted fantasy illustration of one huge heavy four-legged beast sitting upright in a sunlit forest glade. Its body is squat, bulky and hunched, broad and barrel-chested with massive sloping shoulders, covered all over in thick shaggy brown fur, standing on four short powerful limbs that end in wide flat paws with long curved claws; it has a very short thick neck so the head sits low against the shoulders, and only a short stubby tail. Its face is not furred at all: the whole front of its head is (one large hard hooked beak of pale horn:1.5), curving downward to a sharp point like a bird of prey, and this beak takes the place of any muzzle — there is no nose and no mouth on this creature, only the beak. Around and behind the beak the head is covered in dense layered feathers with two very large round forward-facing yellow eyes and tufted feather ridges above them, and those head feathers blend down into the shoulder fur. Richly detailed painterly fur and feather texture',
  moon: 'An enormous crescent moon low in an autumn night sky, filling the scene above bare trees; the dark of its inner curve holds a faint second glow, something withheld and waiting to be asked for',
  // "Transparent block with objects suspended inside" is a description of an
  // aquarium, and the model built one. Reframed as a living slime creature
  // resting on the floor: no container words, no 'suspended', no 'block'.
  // Attempt 3: naming the gelatinous cube gave stone; describing transparent
  // jelly gave an aquarium; calling it a slime creature lost the cube shape —
  // 'slime' and 'oozing' pull amorphous. Geometry is now weighted and spelled
  // out as flat faces, straight edges and square corners.
  ooze: 'A painted fantasy illustration of an enormous living jelly monster in (the shape of one perfect cube:1.5), with flat square faces, straight sharp edges and square corners like a giant block of quivering translucent green glass, completely filling a vaulted stone sewer passage from wall to wall and floor to ceiling and sliding slowly forward along the wet flagstones; half-dissolved coins, bones and a rusted helm are trapped and digesting inside the jelly',
  path: 'A well-worn dirt path twisting away through dense wilderness, shapes and watchful eyes half-hidden in the shadows to either side; the path itself runs bright and clear ahead, inviting speed',
  pit: 'Looking down into a deep pit gaping open in a stone floor, iron spikes jutting upward from the darkness far below, the broken edge of the floor visible all around the rim where the ground gave way; seen from directly above the opening',
  plant: 'A walking humanoid mushroom the height of a person, a broad domed fungal cap for a head atop a thick pale stalk-like body with short knobbly limbs, standing among damp cave growth and releasing a slow billowing cloud of luminous spores from its cap; the drifting spores arrange themselves into faint sigil shapes as they rise',
  priest: 'A cleric in vestments holding a heavy flanged mace head-down before them, calm and certain, a holy symbol at the breast; a soft column of divine light falls from above and pools at their feet',
  prisoner: 'A rogue pressed against the bars of a dank prison cell, hands outstretched through the gap in appeal, damp straw and stone underfoot; the air about their wrists shimmers with unseen binding',
  puzzle: 'An elaborate wooden puzzle box hanging in mid-air, its interlocking panels partly shifted and light spilling from the seams; one piece has slid free and drifts away, the mechanism left incomplete',
  ring: 'An emerald ring resting in a lined decorative jewellery box with the lid raised, the stone lit from within and throwing green light across the velvet; the band is worked with fine sigils',
  // Reverted: describing the kenku as "a humanoid with a crow's head" produced
  // a worse image than naming it. The model evidently does know this one.
  rogue: 'A kenku in dark clothing lurking in deep shadow with a dagger held low and ready, beaked head tilted, eyes catching the light; an unsuspecting lit figure passes just beyond its reach',
  ruin: 'An elegant longsword and a fine golden crown both crumbling into swirling eddies of grey ash in mid-air, the metal disintegrating from the edges inward, half of each object already gone to drifting dust with nothing solid left beneath them',
  sage: 'An ancient scholar seated among towering stacks of books and unrolled scrolls, eyes closed in recollection; above their head hangs a single clear orb of white light, one exact answer drawn out of all that study',
  shield: 'A round steel shield propped ready against a bunk in a spare military barracks, its straps worn from use, a helm and mail laid beside it; a faint protective sheen runs across its face',
  ship: 'A three-masted sailing ship under full canvas crossing the open sea, at its prow a carved wooden figurehead of a winged feathered serpent; the crew work the rigging with practised certainty, every rope and sail exactly where it should be',
  skull: 'A skeletal figure shrouded in a swirling dark robe, the fabric moving as though in wind, the bare skull clearly visible within the hood; it stands alone facing the viewer, patient and final',
  // The word "staff" also means personnel, which is very likely why a person
  // kept appearing despite (person:1.5) in the negative — the noun itself was
  // cueing them. Uses rod / quarterstaff wording instead. Card name unchanged.
  // Attempt 3. 'staff' means personnel; 'quarterstaff' and 'rod' are weapon
  // words that summon a wielder — it came back as a person with a long sword.
  // Now a plain wooden pole and, like `mine`, the only object in the picture.
  // Attempt 4. Sole-object framing worked, but a large vertical pole reads as
  // a support beam. Scale and angle are now pinned: broomstick-thick, person-
  // height, leaning on a steep diagonal rather than standing upright.
  // Attempt 5: person -> person with sword -> support beam -> tree. 'wooden
  // pole' plus 'runes carved along it' reads as a bark-covered trunk. Now an
  // unmistakably manufactured object: a smooth polished lacquered cane, thumb-
  // thick, indoors, with the outdoor reading suppressed hard.
  // Attempt 6. 'Cane' fixed the tree but brought a curved handle with it.
  // Neutral word ('shaft') plus the straightness stated outright: no handle,
  // no hook, no curve, even thickness end to end.
  staff: 'A painted fantasy illustration of one single slim polished black wooden shaft, perfectly straight along its whole length from end to end with no handle, no hook, no knob and no curve of any kind, exactly the same thickness at the top as at the bottom, smooth and lacquered, only about as thick as a thumb and about as tall as a person, propped at an angle against the inside corner of a small bare stone room indoors; faint pale glowing runes are inlaid flush into its smooth polished surface; the slender straight shaft is the only object in the entire picture and the small stone room is completely empty otherwise',
  stairway: 'A stone spiral stairway seen from its landing, one flight climbing into clean light above and the other descending into clutter and shadow below; something ornate and valuable glints part way down the dark steps',
  star: 'A single brilliant star burning in a clear spring twilight sky above a dark horizon, far brighter than the others just emerging around it; its light falls in a thin steady beam onto the land below',
  // PF2e pantheon: Pharasma, goddess of fate and prophecy, replaces Greyhawk's
  // Istus. Named and described — the model knows neither deity, and her spiral
  // holy symbol is the readable iconography.
  // Fourth attempt. "Robed goddess statue" pulls Hindu/Buddhist iconography
  // the same way "temple" did, so the carving tradition is now stated outright
  // as western medieval European, and the medium is stated first.
  statue: 'A painted fantasy illustration with visible brushwork, showing a weathered grey stone statue carved in the western medieval European cathedral tradition: a tall robed woman standing on a stone plinth, severe and still, her gown carved in deep gothic folds, a simple spiral emblem cut into the stone at her breast, pale lichen in the crevices; she holds out in both hands a wide fanned spread of five large golden cards, each card turned so its ornate patterned gold back faces the viewer, the fan of cards prominent and central',
  sun: 'A blazing summer sun high in a clear sky, its rays flooding the whole scene with gold and bright fields below; the light is generous and expanding, everything beneath it lifted',
  talons: 'A great scaled clawed hand reaching through empty air toward an emerald ring that floats separately in front of it, the claw not touching and not wearing it; the ring is already crumbling to smoke at the claw\'s approach',
  tavern: 'An adventuring party crowded around a heavy table in a busy tavern, eating and laughing together, tankards raised and firelight on their faces; the whole warm room leans toward their corner',
  // "Incense" plus gold ornament read as a Buddhist temple. Architecture is
  // now specified as western gothic stone, and the incense is just pale smoke.
  // Attempt 3. Plain 'temple' gave a Buddhist temple; adding 'gothic' to fix
  // that gave a photoreal Christian cathedral. The word 'temple' and every
  // real-world tradition word are gone — described as a fantasy sanctuary.
  temple: 'A painted fantasy illustration with visible brushwork, seen from the ground outside at dusk looking up a wide flight of worn stone steps toward the tall open doorway of an ancient stone sanctuary; massive weathered stone columns carved with unfamiliar runes and spiral sigils flank a great arched opening, iron braziers burn low on the steps to either side, and the viewer stands outside on the ground facing the building; the whole interior beyond the open doorway is filled with bright warm welcoming golden light, brilliantly lit from within, and that light floods out through the doorway and spills down the steps toward the viewer with thin pale smoke drifting out in it',
  throne: 'An ostentatious carved throne standing empty on a raised dais, a jewelled crown resting on its seat and a ceremonial sword leaning against one armrest; the hall around it is arranged so every sightline ends at that chair',
  tomb: 'A quiet underground burial chamber holding a single plain stone casket, dust thick on its lid and carved walls dim around it; a thin thread of pale light has begun to seep from the seam beneath the lid',
  tower: 'A tall ornate tower of black stone looming over a desolate windswept landscape, no road leading to it and no light in its high windows; two faint paths diverge from its base into the waste, one pale and one dark',
  tree: 'A great tree that has broken through a fortress wall and reclaimed part of the keep, roots gripping fallen masonry and branches filling the breach; its bark is thick and plated where the stone failed',
  undead: 'A gaunt lich in tattered finery raising one hand to beckon, pale souls streaming toward it out of the dark; one risen figure at the front does not look at the lich at all, its burning gaze fixed past the viewer',
  // Came back near-monochrome and sparse. Colour is named explicitly and the
  // spiral is given structure so the composition has something to render.
  void: 'An immense whirlpool of deep indigo and violet nothingness spiralling inward, its arms streaked with cold teal and dying gold starlight and drifting broken debris, turning slowly toward a central absolute darkness that devours everything drawn into it; faint human shapes are strung out along the spiral arms, stretched and thinning as they are pulled inward',
  // Head and greataxe were being clipped by the composited frame, so the
  // subject is explicitly pulled into the middle with margin all round.
  warrior: 'A barbarian in furs with scarred arms, standing centred in the middle of the picture with generous empty space around all four edges, the whole figure and the full length of the heavy greataxe well inside the picture and not touching any edge, braced and certain; the weapon looks light in their grip, more strength behind it than their build suggests',
  well: 'A round stone well standing in a peaceful sunlit meadow thick with wildflowers, its bucket and rope at the rim; three small motes of coloured light drift up out of the shaft and hang above the opening',
};

// Per-card suppression, appended to the shared negative in generate-art.mjs.
// Each entry exists because review found the model reliably inventing
// something the flavor text does not contain.
const NEGATIVES = {
  // Two-eyed-face prior overwhelms "one central eye"; proven by a bare test.
  aberration: '(two eyes:1.4), (pair of eyes:1.4), (human face:1.3), (humanoid body:1.3)',
  // Iron bars bound themselves to the stairs instead of the gate.
  donjon: '(metal staircase:1.4), (ladder:1.3), (spiral staircase:1.2)',
  gem: '(photograph:1.6), (photorealistic:1.6), (jewellery photography:1.5), (product photo:1.5), (studio lighting:1.5), (macro photography:1.5), (catalogue photo:1.4), (velvet display:1.4), (bokeh:1.3)',
  // Letter-like ornament appeared in the corners.
  knight: '(monogram:1.5), (initials:1.5), (heraldic lettering:1.4), (two swords:1.5), (double-ended blade:1.5), (two hilts:1.5), (photograph:1.5), (photorealistic:1.5), (construction paper:1.5), (plain cardboard:1.5), (steel plate armour:1.4), (simplistic:1.4)',
  // Object cards: the model keeps adding a person the flavor does not have.
  lance: '(person:1.5), (human figure:1.5), (man:1.5), (knight:1.5), (dragonborn:1.5), (dragon:1.4), (scales:1.4), (armour:1.4), (multiple weapons:1.4), (weapon collection:1.4), (sceptre:1.5), (magic wand:1.5), (jewelled encrusted:1.4), (sword:1.4)',
  mine: '(person:1.5), (human figure:1.5), (miner:1.5), (man:1.5), (face:1.4), (mining helmet:1.4), (hard hat:1.4), (lantern:1.4), (oil lamp:1.4), (cartoon:1.4)',
  staff: '(person:1.5), (human figure:1.5), (people:1.5), (hands:1.5), (sword:1.5), (blade:1.5), (spear:1.5), (weapon:1.4), (curved handle:1.6), (hooked top:1.6), (crook:1.6), (walking stick:1.5), (umbrella:1.5), (knob:1.4), (tree:1.5), (bark:1.5), (outdoors:1.5), (forest:1.5), (support beam:1.5), (column:1.5)',
  // "Gelatinous cube" is unknown to the model; it rendered stone.
  ooze: '(aquarium:1.5), (fish tank:1.5), (glass tank:1.5), (terrarium:1.5), (display case:1.5), (amorphous blob:1.5), (round blob:1.5), (formless puddle:1.5), (slime puddle:1.4), (floating in air:1.4), (stone cube:1.4)',
  pit: '(tower:1.5), (spire:1.4), (cave entrance:1.4), (mountain:1.3)',
  ruin: '(intact sword:1.3), (solid undamaged metal:1.3)',
  // (playing card faces:1.5) + (card pips:1.4) suppressed the cards entirely on
  // the first attempt — narrowed to just the pip suits, photo terms pushed up.
  statue: '(photograph:1.6), (photorealistic:1.6), (hyperrealistic:1.5), (museum photograph:1.4), (buddha:1.5), (buddhist statue:1.5), (hindu statue:1.5), (asian sculpture:1.5), (bronze idol:1.4), (seated figure:1.3), (hearts spades clubs diamonds:1.4), (poker cards:1.3)',
  // The claw wore the ring instead of reaching for it.
  talons: '(ring on finger:1.5), (wearing a ring:1.5), (worn jewellery:1.4)',
  tavern: '(cartoon:1.5), (cartoonish:1.5), (comic book:1.4), (caricature:1.4), (flat colours:1.3)',
  balance: '(simplistic:1.4), (flat design:1.4), (minimalist:1.4), (vector art:1.4), (icon:1.4), (clip art:1.4)',
  construct: '(humanoid robot:1.3), (android:1.3), (organic creature:1.3)',
  elemental: '(bipedal humanoid:1.4), (two arms:1.3), (human face:1.3)',
  plant: '(ordinary mushroom:1.4), (small fungus:1.4), (no limbs:1.2)',

  fiend: '(small imp:1.3), (humanoid man:1.3)',
  fey: '(wolf pack:1.2), (fully solid animal:1.3), (intact hindquarters:1.3)',

  flames: '(plain man:1.3), (no chains:1.3)',
  monstrosity: '(muzzle:1.6), (snout:1.6), (nose:1.5), (mouth:1.5), (furred face:1.6), (whiskers:1.5), (wings:1.5), (talons:1.4), (feathered torso:1.5), (two-legged:1.4), (long neck:1.5), (long tail:1.5), (mane:1.5), (lion:1.5), (simplistic:1.4)',
  void: '(monochrome:1.5), (greyscale:1.5), (empty composition:1.3), (minimalist:1.4), (plain background:1.3)',
  warrior: '(comic book art:1.5), (cartoon:1.5), (cel shading:1.4), (bold outlines:1.3), (cropped:1.4), (close-up:1.3)',
  // Camera kept ending up inside the building looking out.
  temple: '(interior view:1.4), (seen from inside:1.4), (church:1.5), (cathedral:1.5), (christian:1.5), (crucifix:1.5), (stained glass window:1.4), (buddhist temple:1.5), (pagoda:1.5), (east asian architecture:1.5), (dark interior:1.5), (black doorway:1.5), (shadowy entrance:1.4), (photograph:1.5)',
};

const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));

const missing = cards.filter((c) => !SCENES[c.id]).map((c) => c.id);
const extra = Object.keys(SCENES).filter((id) => !cards.some((c) => c.id === id));
if (missing.length || extra.length) {
  if (missing.length) console.error(`No scene written for: ${missing.join(', ')}`);
  if (extra.length) console.error(`Scene for unknown card: ${extra.join(', ')}`);
  process.exit(1);
}

for (const card of cards) {
  const prompt = PREFIX + SCENES[card.id] + SUFFIX;
  if (/\btarot\b/i.test(prompt)) {
    console.error(`${card.id}: prompt mentions "tarot"`);
    process.exit(1);
  }
  // Deliberately NOT rejecting prompts that contain the card's own name: for
  // object cards the name is the subject ("a book", "a stone well"), and the
  // old prompts carried their card name in 28 of 66 without it ever being
  // rendered as text. What got rendered was the title-position prefix
  // ("Tarot card:"), not nouns inside the sentence.
  card.art.prompt = prompt;
  if (NEGATIVES[card.id]) card.art.negative = NEGATIVES[card.id];
  else delete card.art.negative;
}

if (dry) {
  console.log(`Dry run: ${cards.length} prompts would be rewritten.\n`);
  console.log('Tower, after:\n  ' + cards.find((c) => c.id === 'tower').art.prompt);
  console.log('\nTemple, after:\n  ' + cards.find((c) => c.id === 'temple').art.prompt);
} else {
  writeFileSync(cardsPath, `${JSON.stringify(cards, null, 2)}\n`);
  console.log(`Rewrote ${cards.length} prompts on the hybrid direction.`);
}
