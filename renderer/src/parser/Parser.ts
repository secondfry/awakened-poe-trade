// Clipboard parser: turns the text of a copied item into a ParsedItem.
//
// Stage order (parseClipboard):
//  1. itemTextToSections splits on "--------" lines. Then, if the first
//     section's 3rd line is CANNOT_USE_ITEM, parseClipboard drops that line
//     and puts Item Class and Rarity in front of the next section, so the
//     nameplate is one section again.
//  2. parseNamePlate consumes sections[0]: name, baseType (the line after
//     name, if any), rarity, and category for three rarity texts only. The
//     Item Class line is checked to exist, but its value is discarded: it
//     never sets category.
//  3. The `parsers` array, in order. A section parser is offered the
//     remaining sections one by one: SECTION_PARSED removes that section so
//     no later parser sees it, PARSER_SKIPPED stops offering sections to it.
//     A virtual parser runs once on the whole state. Sections that no parser
//     takes are ignored.
//     a. Before the lookup (item.info is undefined): parseUnidentified,
//        parseSuperior, parseFoulborn, parseVestigial, parseSynthesised,
//        parseCategoryByHelpText, parseMapTier. They set flags and strip
//        prefixes/suffixes (or, for Viscera, replace the name) so
//        name/baseType match a database name.
//     b. normalizeName: magic name -> base type, metamorph name -> organ.
//     c. findInDatabase: info, infoVariants, and category from the database.
//        Fails with 'item.unknown' if nothing is found.
//     d. Property section parsers (below the "// -----" line). They may read
//        item.info and item.category; many are gated on category, rarity or
//        info.refName and return PARSER_SKIPPED for other items.
//     e. parseModifiers x4: each call takes one section with mod lines; the
//        enchant/scourge/implicit/explicit labels are notes, not filters.
//     f. Post-steps (virtual): augmentModifiers, transformToLegacyModifiers
//        (statsByType), parseFractured, pickCorrectVariant (final info and
//        uniqueBase), calcDisenchantDust, calcBasePercentile.
//
// When rarity and category become known:
//  - rarity is set only in parseNamePlate: Normal (also Quest), Magic, Rare,
//    Unique. Currency, divination card, gem and Viscera items keep rarity
//    undefined for the whole parse, so rarity-gated parsers (parseModifiers,
//    parseFoil, parseSuperior, parseFoulborn, parseVestigial) skip them;
//    parseModifiers lets Viscera through by info.refName.
//  - category comes from, in order: parseNamePlate (Currency, DivinationCard,
//    Gem, from the rarity text), parseCategoryByHelpText (CapturedBeast,
//    MetamorphSample, Voidstone), else findInDatabase from
//    info.craftable.category (or the unique's base). Before findInDatabase
//    category is undefined for every other item. The one exception after the
//    lookup: parseViscera sets the Viscera slot category, which
//    findInDatabase leaves undefined.
//
// Per item type:
//  - Currency and stackables: category Currency from the rarity text;
//    "Rarity: Normal" stackables keep category undefined (their database
//    entries are not craftable); info from ITEM by name; parseStackSize.
//    No modifiers are parsed for "Rarity: Currency".
//  - Divination cards: category from the rarity text; info from
//    DIVINATION_CARD by name; parseStackSize.
//  - Gems: category from the rarity text; info from GEM by name. Transfigured
//    gems are their own GEM entries, so they need no extra step.
//    parseRequirements, parseGem (level, quality), parseVaalGem,
//    parseImbuedGem. No parseModifiers.
//  - Captured beasts: parseCategoryByHelpText; info from CAPTURED_BEAST by
//    baseType ?? name.
//  - Metamorph samples: parseCategoryByHelpText; normalizeName renames to an
//    English "Metamorph <organ>"; info from ITEM by that name.
//  - Voidstones: parseCategoryByHelpText; findInDatabase ignores the name and
//    always uses ITEM ref 'Charged Compass'.
//  - Viscera: no Rarity line, so rarity stays undefined. parseCategoryByHelpText
//    renames the item to 'Viscera', dropping tier and base from the name;
//    info is that one ITEM entry, which is not craftable, so category is
//    still undefined after the lookup. parseViscera then sets the slot
//    category (Head, Torso, Upper Limb, Lower Limb Viscera) from the
//    one-line slot section; parseItemLevel, parseRequirements, and
//    parseModifiers (let through by info.refName) for the implicit.
//  - Maps: parseMapTier strips " (Tier N)" before the lookup; category Map
//    from the database; parseMap; tier-specific variants in
//    pickCorrectVariant.
//  - Gear: the base comes from the name for normal and unidentified items
//    (parseSuperior strips "Superior"), from the affixed name for magic items
//    (normalizeName), from the baseType line for rare and identified unique
//    items. Identified uniques look up UNIQUE by name, filtered to the
//    baseType's base. Unidentified uniques resolve to the base item only;
//    the UI later calls makeIdentifiedUnique. Then parseItemLevel,
//    parseRequirements, parseArmour, parseWeapon, parseAccessory
//    (jewellery/quiver), parseCorrupted, parseFoil (uniques), parseInfluence,
//    parseSockets, parseMirrored, parseSplit, parseModifiers, parseFractured.
//    Name/base prefixes: parseFoulborn, parseVestigial, parseSynthesised.
//  - Unique variants: findInDatabase keeps all entries in infoVariants and
//    takes the first; pickCorrectVariant picks by disc conditions at the end.
//  - Flasks: parseFlask consumes the charges section so it is not read as
//    mods. Tinctures: parseTincture (quality).
//  - Jewels: no dedicated parser; category from the database, mods via
//    parseModifiers.
//  - Heist: parseHeistContract, parseHeistBlueprint (category-gated); heist
//    gear takes the gear path.
//  - Sanctum: Forbidden Tome area level via parseAreaLevel; relics take the
//    gear path.
//  - Logbooks: parseAreaLevel, parseLogbookArea (up to 3 areas).
//  - Other refName-gated items: Chronicle of Atzoatl (parseAreaLevel,
//    parseAtzoatlRooms), Mirrored Tablet, Filled Coffin (parseItemLevel reads
//    Corpse Level, parseFilledCoffin), Scrying Orb, Mercenary Warrant
//    (parseMercenary, parseMercenaryGems x6). Category-gated: Charts
//    (parseChart).

import { Result, ok, err } from 'neverthrow'
import {
  CLIENT_STRINGS as _$,
  ITEM_BY_TRANSLATED,
  ITEM_BY_REF,
  STAT_BY_MATCH_STR,
  StatBetter,
  BaseType
} from '@/assets/data'
import { ModifierType, ModifierMechanic, sumStatsByModType } from './modifiers'
import { linesToStatStrings, tryParseTranslation, getRollOrMinmaxAvg, ParsedStat } from './stat-translations'
import { ItemCategory, JEWELLERY } from './meta'
import { IncursionRoom, ParsedItem, ItemInfluence, ItemRarity } from './ParsedItem'
import { magicBasetype } from './magic-name'
import { isModInfoLine, groupLinesByMod, parseModInfoLine, parseModType, ModifierInfo, ParsedModifier, ENCHANT_LINE, SCOURGE_LINE, IMPLICIT_LINE } from './advanced-mod-desc'
import { calcPropPercentile, QUALITY_STATS } from './calc-q20'

type SectionParseResult =
  | 'SECTION_PARSED'
  | 'SECTION_SKIPPED'
  | 'PARSER_SKIPPED'

type ParserFn = (section: string[], item: ParserState) => SectionParseResult
type VirtualParserFn = (item: ParserState) => Result<never, string> | void

interface ParserState extends ParsedItem {
  name: string
  baseType: string | undefined
  infoVariants: BaseType[]
}

// Order matters: a section taken by one parser is never seen by later ones,
// and each parser may only read state set by parsers above it.
// Above the "// -----" line item.info is not set yet.
const parsers: Array<ParserFn | { virtual: VirtualParserFn }> = [
  // must run first: parseSuperior, parseFoulborn and findInDatabase read isUnidentified
  parseUnidentified,
  { virtual: parseSuperior },
  { virtual: parseFoulborn },
  { virtual: parseVestigial },
  parseSynthesised,
  parseCategoryByHelpText,
  { virtual: parseMapTier },
  { virtual: normalizeName },
  { virtual: findInDatabase },
  // -----------
  // From here item.info is set (findInDatabase errors otherwise); item.category is set unless the entry is neither craftable nor unique.
  parseItemLevel,
  parseRequirements,
  parseTalismanTier,
  parseGem,
  parseVaalGem,
  parseArmour,
  parseWeapon,
  parseAccessory,
  parseFlask,
  parseTincture,
  parseStackSize,
  parseCorrupted,
  parseImbuedGem,
  parseFoil,
  parseInfluence,
  parseMap,
  parseSockets,
  parseHeistContract,
  parseHeistBlueprint,
  parseChart,
  parseAreaLevel,
  parseAtzoatlRooms,
  parseMirroredTablet,
  parseFilledCoffin,
  parseMirrored,
  parseSplit,
  parseScryingOrb,
  parseMercenary,
  parseViscera,
  parseLogbookArea,
  parseLogbookArea,
  parseLogbookArea,
  parseMercenaryGems,
  parseMercenaryGems,
  parseMercenaryGems,
  parseMercenaryGems,
  parseMercenaryGems,
  parseMercenaryGems,
  // one entry per mod section; each takes whichever remaining section has mod lines first
  parseModifiers, // enchant
  parseModifiers, // scourge
  parseModifiers, // implicit
  parseModifiers, // explicit
  // post-steps: all sections are parsed, newMods is final
  { virtual: augmentModifiers },
  { virtual: transformToLegacyModifiers },
  { virtual: parseFractured },
  { virtual: pickCorrectVariant },
  { virtual: calcDisenchantDust },
  { virtual: calcBasePercentile }
]

const VALUE_AUGMENTED = ' (augmented)'

// Entry point. Runs parseNamePlate, then every entry of `parsers` in order.
// Any exception thrown by a parser becomes 'item.parse_error'.
export function parseClipboard (clipboard: string): Result<ParsedItem, string> {
  try {
    let sections = itemTextToSections(clipboard)

    if (sections[0][2] === _$.CANNOT_USE_ITEM) {
      sections[0].pop() // remove CANNOT_USE_ITEM line
      sections[1].unshift(...sections[0]) // prepend item class & rarity into second section
      sections.shift() // remove first section where CANNOT_USE_ITEM line was
    }
    const parsed = parseNamePlate(sections[0])
    if (!parsed.isOk()) return parsed

    sections.shift()
    parsed.value.rawText = clipboard

    // each section can be parsed at most by one parser
    for (const parser of parsers) {
      if (typeof parser === 'object') {
        const error = parser.virtual(parsed.value)
        if (error) return error
        continue
      }

      for (const section of sections) {
        // workaround upstream bug
        parseEldritchItem(section)

        const result = parser(section, parsed.value)
        if (result === 'SECTION_PARSED') {
          sections = sections.filter(s => s !== section)
          break
        } else if (result === 'PARSER_SKIPPED') {
          break
        }
      }
    }
    return Object.freeze(parsed)
  } catch (e) {
    console.log(e)
    return err('item.parse_error')
  }
}

function itemTextToSections (text: string) {
  const lines = text.split(/\r?\n/)
  if (lines[lines.length - 1] === '') {
    lines.pop()
  }

  const sections: string[][] = [[]]
  lines.reduce((section, line) => {
    if (line !== '--------') {
      section.push(line)
      return section
    } else {
      const section: string[] = []
      sections.push(section)
      return section
    }
  }, sections[0])
  return sections.filter(section => section.length)
}

// Stage b, virtual. Rewrites item.name into a database name.
// Magic: replaces the affixed name with the longest craftable base found in
// it; runs on every magic item, whatever its category.
// MetamorphSample: needs parseCategoryByHelpText to have run; maps the
// organ name to an English 'Metamorph <organ>' name.
function normalizeName (item: ParserState) {
  if (item.rarity === ItemRarity.Magic) {
    const baseType = magicBasetype(item.name)
    if (baseType) {
      item.name = baseType
    }
  }

  if (item.category === ItemCategory.MetamorphSample) {
    if (_$.METAMORPH_BRAIN.test(item.name)) {
      item.name = 'Metamorph Brain'
    } else if (_$.METAMORPH_EYE.test(item.name)) {
      item.name = 'Metamorph Eye'
    } else if (_$.METAMORPH_LUNG.test(item.name)) {
      item.name = 'Metamorph Lung'
    } else if (_$.METAMORPH_HEART.test(item.name)) {
      item.name = 'Metamorph Heart'
    } else if (_$.METAMORPH_LIVER.test(item.name)) {
      item.name = 'Metamorph Liver'
    }
  }
}

// Stage c, virtual. Reads category (only the early ones: Currency,
// DivinationCard, Gem, CapturedBeast, MetamorphSample, Voidstone), rarity,
// isUnidentified, name and baseType, so it must run after every name/baseType
// cleanup above it. Branch order matters: the category branches come before
// the unique branch, so e.g. a unique-rarity metamorph sample is looked up in ITEM.
// Writes infoVariants, info (first variant for now, pickCorrectVariant
// replaces it) and, if still unset, category from the database.
// Identified uniques: assumes a baseType line and keeps only entries whose
// unique.base is that base.
function findInDatabase (item: ParserState) {
  let info: BaseType[] | undefined
  if (item.category === ItemCategory.DivinationCard) {
    info = ITEM_BY_TRANSLATED('DIVINATION_CARD', item.name)
  } else if (item.category === ItemCategory.CapturedBeast) {
    info = ITEM_BY_TRANSLATED('CAPTURED_BEAST', item.baseType ?? item.name)
  } else if (item.category === ItemCategory.Gem) {
    info = ITEM_BY_TRANSLATED('GEM', item.name)
  } else if (item.category === ItemCategory.MetamorphSample) {
    info = ITEM_BY_TRANSLATED('ITEM', item.name)
  } else if (item.category === ItemCategory.Voidstone) {
    info = ITEM_BY_REF('ITEM', 'Charged Compass')
  } else if (item.rarity === ItemRarity.Unique && !item.isUnidentified) {
    info = ITEM_BY_TRANSLATED('UNIQUE', item.name)
  } else {
    info = ITEM_BY_TRANSLATED('ITEM', item.baseType ?? item.name)
  }
  if (!info?.length) {
    return err('item.unknown')
  }
  if (info[0].unique) {
    const baseTypes = ITEM_BY_TRANSLATED('ITEM', item.baseType!)
    if (!baseTypes?.length) return err('item.unknown')

    const baseTypeRef = baseTypes[0].refName
    info = info.filter(info => info.unique!.base === baseTypeRef)
  }
  item.infoVariants = info
  // choose 1st variant, correct one will be picked at the end of parsing
  item.info = info[0]
  // same for every variant
  if (!item.category) {
    if (item.info.craftable) {
      item.category = item.info.craftable.category
    } else if (item.info.unique) {
      item.category = ITEM_BY_REF('ITEM',
        item.info.unique.base)![0].craftable!.category
    }
  }
}

// Not part of parseClipboard. Called by the UI after the user picks which
// unique an unidentified unique is; info becomes the unique and uniqueBase
// the base parsed earlier. Only dust is recalculated, no other post-step re-runs.
export function makeIdentifiedUnique (uniqueInfo: BaseType, unidentified: ParsedItem): ParsedItem {
  const newItem: ParsedItem = {
    ...unidentified,
    info: uniqueInfo,
    uniqueBase: unidentified.info
  }

  calcDisenchantDust(newItem)

  return Object.freeze(newItem)
}

// Pre-lookup, virtual. Not gated on category (unknown here): any item whose
// baseType, or name if there is none, ends with " (Tier N)" gets mapTier and
// loses that suffix, so findInDatabase can find the map base.
function parseMapTier (item: ParserState) {
  const execResult = _$.MAP_TIER.exec(item.baseType || item.name)
  if (!execResult) return

  item.mapTier = Number(execResult[1])

  if (item.baseType) {
    item.baseType = item.baseType.replace(execResult[0], '')
  } else {
    item.name = item.name.replace(execResult[0], '')
  }
}

function parseAreaPropNested (line: string, item: ParsedItem): boolean {
  if (line.startsWith(_$.MAP_ITEM_QUANTITY)) {
    item.areaItemQuantity = parseInt(line.slice(_$.MAP_ITEM_QUANTITY.length), 10)
    return true
  } else if (line.startsWith(_$.MAP_ATLAS_DROPS)) {
    item.areaAtlasDrops = parseInt(line.slice(_$.MAP_ATLAS_DROPS.length), 10)
    return true
  } else if (line.startsWith(_$.MAP_ITEM_RARITY)) {
    item.areaItemRarity = parseInt(line.slice(_$.MAP_ITEM_RARITY.length), 10)
    return true
  } else if (line.startsWith(_$.MAP_MONSTER_PACK_SIZE)) {
    item.areaPackSize = parseInt(line.slice(_$.MAP_MONSTER_PACK_SIZE.length), 10)
    return true
  }
  return false
}

// Maps only (category from findInDatabase). Area quantity/atlas drops/rarity/pack size,
// "more X" props, Map Area and completion reward.
function parseMap (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.Map) return 'PARSER_SKIPPED'

  let isParsed: SectionParseResult = 'SECTION_SKIPPED'

  for (const line of section) {
    if (parseAreaPropNested(line, item)) {
      isParsed = 'SECTION_PARSED'
    } else if (line.startsWith(_$.MAP_MORE_MAPS)) {
      item.mapMoreMaps = parseInt(line.slice(_$.MAP_MORE_MAPS.length), 10)
      isParsed = 'SECTION_PARSED'
    } else if (line.startsWith(_$.MAP_MORE_THREADS)) {
      item.mapMoreThreads = parseInt(line.slice(_$.MAP_MORE_THREADS.length), 10)
      isParsed = 'SECTION_PARSED'
    } else if (line.startsWith(_$.MAP_MORE_CURRENCY)) {
      item.mapMoreCurrency = parseInt(line.slice(_$.MAP_MORE_CURRENCY.length), 10)
      isParsed = 'SECTION_PARSED'
    } else if (line.startsWith(_$.MAP_MORE_DIVINATION_CARDS)) {
      item.mapMoreDivCards = parseInt(line.slice(_$.MAP_MORE_DIVINATION_CARDS.length), 10)
      isParsed = 'SECTION_PARSED'
    } else if (line.startsWith(_$.MAP_AREA)) {
      const areaName = section[0].slice(_$.MAP_AREA.length)
      const areaInfo = ITEM_BY_TRANSLATED('AREA', areaName)
      if (!areaInfo) throw new Error('Unknown Area name.')
      item.mapArea = areaInfo[0]
      isParsed = 'SECTION_PARSED'
    } else if (_$.MAP_COMPLETION_REWARD.test(line)) {
      const rewardName = _$.MAP_COMPLETION_REWARD.exec(line)![1]
      const rewardInfo = ITEM_BY_TRANSLATED('UNIQUE', rewardName)
      if (!rewardInfo) throw new Error('Unknown Unique Item.')
      item.mapCompletionReward = rewardInfo[0]
      isParsed = 'SECTION_PARSED'
    }
  }

  return isParsed
}

// Post-step: needs every parseModifiers call done.
function parseFractured (item: ParserState) {
  if (item.newMods.some(mod => mod.info.type === ModifierType.Fractured)) {
    item.isFractured = true
  }
}

// Post-step: replaces the provisional info from findInDatabase and sets
// uniqueBase for uniques. Variant conditions read armour props, mapTier,
// statsByType and rawText, so it must run after transformToLegacyModifiers.
// category is not re-derived: findInDatabase assumes it is the same for every variant.
function pickCorrectVariant (item: ParserState) {
  item.info = _pickCorrectVariant(item.infoVariants, item) ?? item.infoVariants[0]
  if (item.info.unique) {
    const baseVariants = ITEM_BY_REF('ITEM', item.info.unique.base)!
    item.uniqueBase = _pickCorrectVariant(baseVariants, item) ?? baseVariants[0]
  }
}

function _pickCorrectVariant (variants: BaseType[], item: ParsedItem): BaseType | undefined {
  if (variants.length <= 1) return variants[0]

  for (const variant of variants) {
    const cond = variant.disc!

    if (cond.propAR && !item.armourAR) continue
    if (cond.propEV && !item.armourEV) continue
    if (cond.propES && !item.armourES) continue

    if (cond.mapTier) {
      if (!item.mapTier) continue
      if (cond.mapTier === 'W' && !(item.mapTier <= 5)) continue
      if (cond.mapTier === 'Y' && !(item.mapTier >= 6 && item.mapTier <= 10)) continue
      if (cond.mapTier === 'R' && !(item.mapTier >= 11)) continue
    }

    if (cond.hasImplicit && !item.statsByType.some(calc =>
      calc.type === ModifierType.Implicit &&
      calc.stat.ref === cond.hasImplicit!.ref)
    ) continue

    if (cond.hasExplicit && !item.statsByType.some(calc =>
      calc.type === ModifierType.Explicit &&
      calc.stat.ref === cond.hasExplicit!.ref)
    ) continue

    if (cond.sectionText && !item.rawText.includes(cond.sectionText)) continue

    return variant
  }

  // it may happen that we don't find correct variant
  // i.e. corrupted implicit on Two-Stone Ring
}

// Stage 2: consumes the first section and creates ParserState.
// Lines: Item Class (only checked, value discarded), optional Rarity, name,
// optional baseType. baseType is only there when the item shows two name
// lines (rare, identified unique, ...); otherwise the base is in name.
// Sets rarity (the only place it is ever set) and category for Currency,
// DivinationCard and Gem, which keep rarity undefined. Everything else has
// category undefined until parseCategoryByHelpText or findInDatabase.
function parseNamePlate (section: string[]) {
  let line = section.shift()
  if (!line?.startsWith(_$.ITEM_CLASS)) {
    return err('item.parse_error')
  }

  line = section.shift()
  let rarityText: string | undefined
  if (line?.startsWith(_$.RARITY)) {
    rarityText = line.slice(_$.RARITY.length)
    line = section.shift()
  }

  let name: string
  if (line != null) {
    name = markupConditionParser(line)
  } else {
    return err('item.parse_error')
  }

  line = section.shift()
  const baseType = line && markupConditionParser(line)

  const item: ParserState = {
    rarity: undefined,
    category: undefined,
    name: name,
    baseType: baseType,
    isUnidentified: false,
    newMods: [],
    statsByType: [],
    unknownModifiers: [],
    influences: [],
    info: undefined!,
    infoVariants: undefined!,
    rawText: undefined!
  }

  switch (rarityText) {
    case _$.RARITY_CURRENCY:
      item.category = ItemCategory.Currency; break
    case _$.RARITY_DIVCARD:
      item.category = ItemCategory.DivinationCard; break
    case _$.RARITY_GEM:
      item.category = ItemCategory.Gem; break
    case _$.RARITY_NORMAL:
    case _$.RARITY_QUEST:
      item.rarity = ItemRarity.Normal; break
    case _$.RARITY_MAGIC:
      item.rarity = ItemRarity.Magic; break
    case _$.RARITY_RARE:
      item.rarity = ItemRarity.Rare; break
    case _$.RARITY_UNIQUE:
      item.rarity = ItemRarity.Unique; break
  }

  return ok(item)
}

// Not gated: any section of at most 2 lines with influence names.
function parseInfluence (section: string[], item: ParsedItem) {
  if (section.length <= 2) {
    const countBefore = item.influences.length

    for (const line of section) {
      switch (line) {
        case _$.INFLUENCE_CRUSADER:
          item.influences.push(ItemInfluence.Crusader)
          break
        case _$.INFLUENCE_ELDER:
          item.influences.push(ItemInfluence.Elder)
          break
        case _$.INFLUENCE_SHAPER:
          item.influences.push(ItemInfluence.Shaper)
          break
        case _$.INFLUENCE_HUNTER:
          item.influences.push(ItemInfluence.Hunter)
          break
        case _$.INFLUENCE_REDEEMER:
          item.influences.push(ItemInfluence.Redeemer)
          break
        case _$.INFLUENCE_WARLORD:
          item.influences.push(ItemInfluence.Warlord)
          break
      }
    }

    if (countBefore < item.influences.length) {
      return 'SECTION_PARSED'
    }
  }
  return 'SECTION_SKIPPED'
}

// Not gated. "Corrupted" sets isCorrupted = {}, "Twice Corrupted" sets
// { twice: true }, "Unmodifiable" sets {} plus isUnmodifiable. isCorrupted
// stays undefined otherwise, so test it for truthiness.
function parseCorrupted (section: string[], item: ParsedItem) {
  if (section[0] === _$.CORRUPTED) {
    item.isCorrupted = {}
    return 'SECTION_PARSED'
  } else if (section[0] === _$.TWICE_CORRUPTED) {
    item.isCorrupted = { twice: true }
    return 'SECTION_PARSED'
  } else if (section[0] === _$.UNMODIFIABLE) {
    item.isCorrupted = {}
    item.isUnmodifiable = true
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Uniques only (rarity from parseNamePlate).
function parseFoil (section: string[], item: ParsedItem) {
  if (item.rarity !== ItemRarity.Unique) {
    return 'PARSER_SKIPPED'
  }
  if (section[0] === _$.FOIL_UNIQUE) {
    item.isFoil = true
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Pre-lookup, first parser. Sets isUnidentified, which later parsers and
// findInDatabase read.
function parseUnidentified (section: string[], item: ParsedItem) {
  if (section[0] === _$.UNIDENTIFIED) {
    item.isUnidentified = true
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// First parser after the lookup: reads info.refName (Filled Coffin uses Corpse Level).
// Consumes the whole section that holds the level line.
function parseItemLevel (section: string[], item: ParsedItem) {
  let prefix = _$.ITEM_LEVEL
  if (item.info.refName === 'Filled Coffin') {
    prefix = _$.CORPSE_LEVEL
  }

  for (const line of section) {
    if (line.startsWith(prefix)) {
      item.itemLevel = Number(line.slice(prefix.length))
      return 'SECTION_PARSED'
    }
  }
  return 'SECTION_SKIPPED'
}

// Not gated: takes the "Requirements:" section only if it has a Level line,
// and sets requiredLevel from it; otherwise the section stays for later
// parsers.
function parseRequirements (section: string[], item: ParsedItem) {
  if (section[0] !== _$.REQUIREMENTS) return 'SECTION_SKIPPED'

  for (const line of section.slice(1)) {
    if (!line.startsWith(_$.REQUIRED_LEVEL)) continue
    // parseInt drops the trailing " (unmet)" suffix
    item.requiredLevel = parseInt(line.slice(_$.REQUIRED_LEVEL.length), 10)
    return 'SECTION_PARSED'
  }

  return 'SECTION_SKIPPED'
}

function parseTalismanTier (section: string[], item: ParsedItem) {
  if (section[0].startsWith(_$.TALISMAN_TIER)) {
    item.talismanTier = Number(section[0].slice(_$.TALISMAN_TIER.length))
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Gems only (category from parseNamePlate). A single-line section naming a
// gem is the Vaal skill; must run before parseImbuedGem, which also takes
// single-line gem sections.
function parseVaalGem (section: string[], item: ParserState) {
  if (item.category !== ItemCategory.Gem) return 'PARSER_SKIPPED'

  if (section.length === 1) {
    const gemInfo = ITEM_BY_TRANSLATED('GEM', section[0])
    if (gemInfo) {
      item.vaalGem = gemInfo[0]
      return 'SECTION_PARSED'
    }
  }
  return 'SECTION_SKIPPED'
}

// Gems only. The properties section (tags line, then Level) gives gemLevel and quality.
function parseGem (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.Gem) {
    return 'PARSER_SKIPPED'
  }
  if (section[1]?.startsWith(_$.GEM_LEVEL)) {
    // "Level: 20 (Max)"
    item.gemLevel = parseInt(section[1].slice(_$.GEM_LEVEL.length), 10)

    parseQualityNested(section, item)

    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Gems only. A single-line section matching a stat is the imbued support,
// pushed as an Imbued mod (gems never reach parseModifiers).
function parseImbuedGem (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.Gem) return 'PARSER_SKIPPED'

  if (section.length === 1) {
    const support = STAT_BY_MATCH_STR(section[0])
    if (!support) return 'SECTION_SKIPPED'

    item.newMods.push({
      info: { tags: [], type: ModifierType.Imbued },
      stats: [{
        stat: support.stat,
        translation: support.matcher
      }]
    })
    item.imbuedGem = true

    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Normal-rarity items plus Currency and DivinationCard (which have no rarity).
function parseStackSize (section: string[], item: ParsedItem) {
  if (item.rarity !== ItemRarity.Normal &&
      item.category !== ItemCategory.Currency &&
      item.category !== ItemCategory.DivinationCard) {
    return 'PARSER_SKIPPED'
  }
  if (section[0].startsWith(_$.STACK_SIZE)) {
    // Portal Scroll "Stack Size: 2[localized separator]448/40"
    const [value, max] = section[0].slice(_$.STACK_SIZE.length).replace(/[^\d/]/g, '').split('/').map(Number)
    item.stackSize = { value, max }

    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

function parseSockets (section: string[], item: ParsedItem) {
  if (section[0].startsWith(_$.SOCKETS)) {
    let sockets = section[0].slice(_$.SOCKETS.length).trimEnd()

    item.sockets = {
      white: (sockets.split('W').length - 1),
      linked: undefined
    }

    sockets = sockets.replace(/[^ -]/g, '#')
    if (sockets === '#-#-#-#-#-#') {
      item.sockets.linked = 6
    } else if (
      sockets === '# #-#-#-#-#' ||
      sockets === '#-#-#-#-# #' ||
      sockets === '#-#-#-#-#'
    ) {
      item.sockets.linked = 5
    }
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

function parseQualityNested (section: string[], item: ParsedItem): boolean {
  for (const line of section) {
    if (line.startsWith(_$.QUALITY)) {
      // "Quality: +20% (augmented)"
      item.quality = parseInt(line.slice(_$.QUALITY.length), 10)
      return true
    }
  }
  return false
}

function parseMemoryStrandsNested (section: string[], item: ParsedItem): boolean {
  for (const line of section) {
    if (line.startsWith(_$.MEMORY_STRANDS)) {
      item.memoryStrands = parseInt(line.slice(_$.MEMORY_STRANDS.length), 10)
      return true
    }
  }
  return false
}

// Not gated on category: takes any section with an armour/evasion/ES/ward/block line.
function parseArmour (section: string[], item: ParsedItem) {
  let isParsed: SectionParseResult = 'SECTION_SKIPPED'

  for (const line of section) {
    if (line.startsWith(_$.ARMOUR)) {
      item.armourAR = parseInt(line.slice(_$.ARMOUR.length), 10)
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.EVASION)) {
      item.armourEV = parseInt(line.slice(_$.EVASION.length), 10)
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.ENERGY_SHIELD)) {
      item.armourES = parseInt(line.slice(_$.ENERGY_SHIELD.length), 10)
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.TAG_WARD)) {
      item.armourWARD = parseInt(line.slice(_$.TAG_WARD.length), 10)
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.BLOCK_CHANCE)) {
      item.armourBLOCK = parseInt(line.slice(_$.BLOCK_CHANCE.length), 10)
      isParsed = 'SECTION_PARSED'; continue
    }
  }

  if (isParsed === 'SECTION_PARSED') {
    parseQualityNested(section, item)
    parseMemoryStrandsNested(section, item)
  }

  return isParsed
}

// Not gated on category: takes any section with a crit/APS/damage line.
function parseWeapon (section: string[], item: ParsedItem) {
  let isParsed: SectionParseResult = 'SECTION_SKIPPED'

  for (const line of section) {
    if (line.startsWith(_$.CRIT_CHANCE)) {
      item.weaponCRIT = parseFloat(line.slice(_$.CRIT_CHANCE.length))
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.ATTACK_SPEED)) {
      item.weaponAS = parseFloat(line.slice(_$.ATTACK_SPEED.length))
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.PHYSICAL_DAMAGE)) {
      item.weaponPHYSICAL = getRollOrMinmaxAvg(line
        .slice(_$.PHYSICAL_DAMAGE.length)
        .split('-').map(str => parseInt(str, 10))
      )
      isParsed = 'SECTION_PARSED'; continue
    }
    if (line.startsWith(_$.ELEMENTAL_DAMAGE)) {
      item.weaponELEMENTAL =
        line.slice(_$.ELEMENTAL_DAMAGE.length)
          .split(', ')
          .map(element => getRollOrMinmaxAvg(element.split('-').map(str => parseInt(str, 10))))
          .reduce((sum, x) => sum + x, 0)

      isParsed = 'SECTION_PARSED'; continue
    }
  }

  if (isParsed === 'SECTION_PARSED') {
    parseQualityNested(section, item)
    parseMemoryStrandsNested(section, item)
  }

  return isParsed
}

// Jewellery and quivers (category from findInDatabase): quality as a pseudo mod, memory strands.
function parseAccessory (section: string[], item: ParsedItem) {
  if (!JEWELLERY.has(item.category!) && item.category !== ItemCategory.Quiver) return 'PARSER_SKIPPED'

  let isParsed: SectionParseResult = 'SECTION_SKIPPED'

  for (const line of section) {
    if (line.endsWith(VALUE_AUGMENTED)) {
      const found = tryParseTranslation({ string: line.slice(0, -VALUE_AUGMENTED.length), unscalable: true }, ModifierType.Pseudo, undefined)
      if (found && found.stat.jewelleryQuality) {
        item.quality = found.roll!.value
        item.newMods.push({
          info: { tags: [], type: ModifierType.Pseudo },
          stats: [found]
        })
        isParsed = 'SECTION_PARSED'
      }
    }
  }

  if (parseMemoryStrandsNested(section, item)) {
    isParsed = 'SECTION_PARSED'
  }

  return isParsed
}

// Viscera only (info.refName). The one-line slot section ("Head", "Torso",
// "Upper Limb", "Lower Limb") sets the slot category; the 'Viscera' ITEM
// entry is not craftable, so findInDatabase left category undefined.
function parseViscera (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Viscera') return 'PARSER_SKIPPED'
  if (section.length === 1) {
    switch (section[0]) {
      case _$.VISCERA_HEAD:
        item.category = ItemCategory.HeadViscera; break
      case _$.VISCERA_LOWER_LIMB:
        item.category = ItemCategory.LowerLimbViscera; break
      case _$.VISCERA_UPPER_LIMB:
        item.category = ItemCategory.UpperLimbViscera; break
      case _$.VISCERA_TORSO:
        item.category = ItemCategory.TorsoViscera; break
    }
    if (item.category) return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Expedition Logbook only (info.refName). Listed 3 times, one call per area section.
function parseLogbookArea (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Expedition Logbook') return 'PARSER_SKIPPED'
  if (section.length < 3) return 'SECTION_SKIPPED'

  // skip Logbook Area line, parse Faction
  const faction = STAT_BY_MATCH_STR(section[1])
  if (!faction || !faction.stat.ref.startsWith('Has Logbook Faction:')) return 'SECTION_SKIPPED'

  const areaMods: ParsedModifier[] = [{
    info: { tags: [], type: ModifierType.Pseudo },
    stats: [{
      stat: faction.stat,
      translation: faction.matcher
    }]
  }]

  const { modType, lines } = parseModType(section.slice(2))
  for (const line of lines) {
    const found = STAT_BY_MATCH_STR(line)
    // Area contains an Expedition Boss (#)
    if (found && found.stat.better === StatBetter.NotComparable) {
      areaMods.push({
        info: { tags: [], type: modType },
        stats: [{
          stat: found.stat,
          translation: found.matcher
        }]
      })
    }
  }

  if (!item.logbookAreaMods) {
    item.logbookAreaMods = [areaMods]
  } else {
    item.logbookAreaMods.push(areaMods)
  }

  return 'SECTION_PARSED'
}

// Mercenary Warrant only (info.refName): level (stored as itemLevel) and build.
function parseMercenary (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Mercenary Warrant') return 'PARSER_SKIPPED'

  for (const line of section) {
    if (line.startsWith(_$.MERCENARY_LEVEL)) {
      item.itemLevel = Number(line.slice(_$.MERCENARY_LEVEL.length))
    } else if (line.startsWith(_$.MERCENARY_BUILD)) {
      let buildInfo = ITEM_BY_TRANSLATED('MERCENARY_BUILD', line.slice(_$.MERCENARY_BUILD.length))
      if (!buildInfo) throw new Error('Unknown Mercenary Build.')

      if (typeof buildInfo[0].mercenaryBuild === 'string') {
        buildInfo = ITEM_BY_REF('MERCENARY_BUILD', buildInfo[0].mercenaryBuild)!
      }
      item.mercenaryBuild = buildInfo[0]
    }
  }

  if (item.mercenaryBuild) {
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

// Mercenary Warrant only. Listed 6 times, one call per skill section.
function parseMercenaryGems (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Mercenary Warrant') return 'PARSER_SKIPPED'

  const skill = tryParseTranslation({ string: section[0], unscalable: true }, ModifierType.Pseudo, ItemCategory.MercenaryWarrant)
  if (!skill) return 'SECTION_SKIPPED'

  const group: ParsedStat[] = [skill]

  for (const line of section.slice(1)) {
    const support = tryParseTranslation({ string: line, unscalable: true }, ModifierType.Pseudo, ItemCategory.MercenaryWarrant)
    if (support) {
      group.push(support)
    }
    if (!support || (support.stat.mercenary!.syntheticFamily && support.stat.mercenary!.tier !== 3)) {
      item.unknownModifiers.push({
        text: `${line} [${section[0]}]`,
        type: ModifierType.Pseudo
      })
    }
  }

  if (!item.mercenarySkills) {
    item.mercenarySkills = []
  }
  item.mercenarySkills.push(group)

  return 'SECTION_PARSED'
}

// Items with a rarity, plus Viscera (info.refName). "Rarity: Currency",
// divination card and gem items have none and are skipped; "Rarity: Normal"
// stackables do get here, with no category (their database entries are not
// craftable).
// Takes a section with advanced mod lines ("{ ... }") or (enchant)/(scourge)
// lines. A plain-copy section marked only with " (implicit)", or with no
// marker, is not taken, so implicit and explicit mods need the advanced
// copy. Reads item.category to match category-specific stat translations,
// so it relies on findInDatabase (parseViscera for Viscera) having set it.
// Pushes to newMods and unknownModifiers.
function parseModifiers (section: string[], item: ParsedItem) {
  if (
    item.rarity !== ItemRarity.Normal &&
    item.rarity !== ItemRarity.Magic &&
    item.rarity !== ItemRarity.Rare &&
    item.rarity !== ItemRarity.Unique &&
    item.info.refName !== 'Viscera'
  ) {
    return 'PARSER_SKIPPED'
  }

  const recognizedLine = section.find(line =>
    line.endsWith(ENCHANT_LINE) ||
    line.endsWith(SCOURGE_LINE) ||
    isModInfoLine(line)
  )

  if (!recognizedLine) {
    return 'SECTION_SKIPPED'
  }

  if (isModInfoLine(recognizedLine)) {
    for (const { modLine, statLines } of groupLinesByMod(section)) {
      const modInfo = parseModInfoLine(modLine)
      if (statLines[0] === _$.VEILED_PREFIX || statLines[0] === _$.VEILED_SUFFIX) {
        modInfo.type = ModifierType.Veiled
        item.isVeiled = true
      }
      parseStatsFromMod(statLines, item, { info: modInfo, stats: [] })
    }
  } else {
    const { modType, lines } = parseModType(section)
    const modInfo: ModifierInfo = {
      type: modType,
      tags: []
    }
    parseStatsFromMod(lines, item, { info: modInfo, stats: [] })
  }

  return 'SECTION_PARSED'
}

function parseMirrored (section: string[], item: ParsedItem) {
  if (section[0] === _$.MIRRORED) {
    item.isMirrored = true
    return 'SECTION_PARSED'
  }
  return 'SECTION_SKIPPED'
}

function parseSplit (section: string[], item: ParsedItem) {
  if (section.length === 1) {
    if (section[0] === _$.SPLIT) {
      item.isSplit = true
      return 'SECTION_PARSED'
    }
  }
  return 'SECTION_SKIPPED'
}

// Flasks only (category from findInDatabase); must run before parseModifiers.
function parseFlask (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.Flask) return 'PARSER_SKIPPED'

  // the purpose of this parser is to "consume" flask buffs
  // so they are not recognized as modifiers

  let isParsed: SectionParseResult = 'SECTION_SKIPPED'

  for (const line of section) {
    if (_$.FLASK_CHARGES.test(line)) {
      isParsed = 'SECTION_PARSED'; break
    }
  }

  if (isParsed === 'SECTION_PARSED') {
    parseQualityNested(section, item)
  }

  return isParsed
}

function parseTincture (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.Tincture) return 'PARSER_SKIPPED'

  if (parseQualityNested(section, item)) {
    return 'SECTION_PARSED'
  }

  return 'SECTION_SKIPPED'
}

function parseScryingOrb (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Scrying Orb') return 'PARSER_SKIPPED'

  if (section.length === 1) {
    if (section[0].startsWith(_$.MAP_AREA)) {
      const areaName = section[0].slice(_$.MAP_AREA.length)
      const areaInfo = ITEM_BY_TRANSLATED('AREA', areaName)
      if (!areaInfo) throw new Error('Unknown Area name.')
      item.mapArea = areaInfo[0]
      return 'SECTION_PARSED'
    }
  }
  return 'SECTION_SKIPPED'
}

// Not in `parsers`: parseClipboard calls it on each section before every
// section parser, mutating the section in place.
function parseEldritchItem (section: string[]): void {
  // these don't have a dedicated section and are appended to last-ish one,
  // it can be Explicit Mods section, Corrupted, or Mirrored line.
  while (section.length) {
    const lastLine = section[section.length - 1]
    if (lastLine === _$.ITEM_EATER || lastLine === _$.ITEM_EXARCH) {
      section.pop()
    } else {
      break
    }
  }
}

// Pre-lookup. Strips the "Synthesised" prefix from baseType, or from name if
// there is no baseType line; throws (-> parse_error) if the prefix is missing.
function parseSynthesised (section: string[], item: ParserState) {
  if (section.length === 1) {
    if (section[0] === _$.SECTION_SYNTHESISED) {
      item.isSynthesised = true
      if (item.baseType) {
        item.baseType = _$.ITEM_SYNTHESISED.exec(item.baseType)![1]
      } else {
        item.name = _$.ITEM_SYNTHESISED.exec(item.name)![1]
      }
      return 'SECTION_PARSED'
    }
  }

  return 'SECTION_SKIPPED'
}

// Pre-lookup, virtual. Needs isUnidentified. Strips "Superior" from name
// for the rarities whose name line is the base type.
function parseSuperior (item: ParserState) {
  if (
    (item.rarity === ItemRarity.Normal) ||
    (item.rarity === ItemRarity.Magic && item.isUnidentified) ||
    (item.rarity === ItemRarity.Rare && item.isUnidentified) ||
    (item.rarity === ItemRarity.Unique && item.isUnidentified)
  ) {
    if (_$.ITEM_SUPERIOR.test(item.name)) {
      item.name = _$.ITEM_SUPERIOR.exec(item.name)![1]
    }
  }
}

// Pre-lookup, virtual. Identified uniques: strips "Foulborn" from name so
// the UNIQUE lookup in findInDatabase matches.
function parseFoulborn (item: ParserState) {
  if (item.rarity !== ItemRarity.Unique || item.isUnidentified) return

  if (_$.FOULBORN_NAME.test(item.name)) {
    item.name = _$.FOULBORN_NAME.exec(item.name)![1]
    item.isFoulborn = true
  }
}

// Pre-lookup, virtual. Uniques: strips "Vestigial" from baseType so the base lookup matches.
function parseVestigial (item: ParserState) {
  if (item.rarity !== ItemRarity.Unique || !item.baseType) return

  if (_$.VESTIGIAL_NAME.test(item.baseType)) {
    item.baseType = _$.VESTIGIAL_NAME.exec(item.baseType)![1]
    item.isVestigial = true
  }
}

// Pre-lookup. Besides the rarity line, the only place before the lookup
// where category is set from item text: CapturedBeast, MetamorphSample,
// Voidstone from their help text. Must run before normalizeName and
// findInDatabase, which branch on it. Viscera help text sets no category:
// it renames the item to 'Viscera', so findInDatabase finds that one ITEM
// entry whatever the tier and base in the name.
function parseCategoryByHelpText (section: string[], item: ParserState) {
  if (section[0] === _$.BEAST_HELP) {
    item.category = ItemCategory.CapturedBeast
    return 'SECTION_PARSED'
  } else if (section[0] === _$.METAMORPH_HELP) {
    item.category = ItemCategory.MetamorphSample
    return 'SECTION_PARSED'
  } else if (section[0] === _$.VOIDSTONE_HELP) {
    item.category = ItemCategory.Voidstone
    return 'SECTION_PARSED'
  } else if (section[0] === _$.VISCERA_HELP) {
    item.name = 'Viscera'
    return 'SECTION_PARSED'
  }

  return 'SECTION_SKIPPED'
}

function parseHeistContract (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.HeistContract) return 'PARSER_SKIPPED'

  if (!parseAreaLevelNested(section, item)) {
    return 'SECTION_SKIPPED'
  }

  item.heistContract = {}

  for (const line of section) {
    const jobMatch = line.match(_$.HEIST_CONTRACT_JOB)
    if (jobMatch) {
      switch (jobMatch.groups!.job) {
        case _$.HEIST_JOB_LOCKPICKING:
          item.heistContract.requiredJob = 'Lockpicking'; break
        case _$.HEIST_JOB_BRUTEFORCE:
          item.heistContract.requiredJob = 'Brute Force'; break
        case _$.HEIST_JOB_PERCEPTION:
          item.heistContract.requiredJob = 'Perception'; break
        case _$.HEIST_JOB_DEMOLITION:
          item.heistContract.requiredJob = 'Demolition'; break
        case _$.HEIST_JOB_COUNTERTHAUMATURGY:
          item.heistContract.requiredJob = 'Counter-Thaumaturgy'; break
        case _$.HEIST_JOB_TRAPDISARMAMENT:
          item.heistContract.requiredJob = 'Trap Disarmament'; break
        case _$.HEIST_JOB_AGILITY:
          item.heistContract.requiredJob = 'Agility'; break
        case _$.HEIST_JOB_DECEPTION:
          item.heistContract.requiredJob = 'Deception'; break
        case _$.HEIST_JOB_ENGINEERING:
          item.heistContract.requiredJob = 'Engineering'; break
      }
      item.heistContract.jobLevel = Number(jobMatch.groups!.level)
      continue
    }

    const targetMatch = line.match(_$.HEIST_CONTRACT_TARGET)
    if (targetMatch) {
      if (targetMatch[1] === _$.HEIST_TARGET_PRICELESS) {
        item.heistContract.targetValue = 'Priceless'
      }
      continue
    }
  }

  return 'SECTION_PARSED'
}

function parseHeistBlueprint (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.HeistBlueprint) return 'PARSER_SKIPPED'

  if (!parseAreaLevelNested(section, item)) {
    return 'SECTION_SKIPPED'
  }

  item.heistBlueprint = {}

  for (const line of section) {
    if (line.startsWith(_$.HEIST_BLUEPRINT_TARGET)) {
      const targetText = line.slice(_$.HEIST_BLUEPRINT_TARGET.length)
      switch (targetText) {
        case _$.HEIST_BLUEPRINT_ENCHANTS:
          item.heistBlueprint.target = 'Enchants'; break
        case _$.HEIST_BLUEPRINT_GEMS:
          item.heistBlueprint.target = 'Gems'; break
        case _$.HEIST_BLUEPRINT_REPLICAS:
          item.heistBlueprint.target = 'Replicas'; break
        case _$.HEIST_BLUEPRINT_TRINKETS:
          item.heistBlueprint.target = 'Trinkets'; break
      }
    } else if (line.startsWith(_$.HEIST_WINGS_REVEALED)) {
      const [revealed, total] = line.slice(_$.HEIST_WINGS_REVEALED.length).split('/')
      item.heistBlueprint.wingsRevealed = parseInt(revealed, 10)
      item.heistBlueprint.wingsTotal = parseInt(total, 10)
    }
  }

  return 'SECTION_PARSED'
}

function parseChart (section: string[], item: ParsedItem) {
  if (item.category !== ItemCategory.Chart) return 'PARSER_SKIPPED'

  if (!parseAreaLevelNested(section, item)) {
    return 'SECTION_SKIPPED'
  }

  const areaInfo = ITEM_BY_TRANSLATED('AREA', section[0])
  if (!areaInfo) throw new Error('Unknown Area name.')
  item.mapArea = areaInfo[0]

  for (const line of section) {
    if (parseAreaPropNested(line, item)) {
      // line parsed
    } else if (line.startsWith(_$.CHART_SULPHUR)) {
      item.chartSulphur = parseInt(line.slice(_$.CHART_SULPHUR.length), 10)
    }
  }

  return 'SECTION_PARSED'
}

function parseAreaLevelNested (section: string[], item: ParsedItem): boolean {
  for (const line of section) {
    if (line.startsWith(_$.AREA_LEVEL)) {
      item.areaLevel = Number(line.slice(_$.AREA_LEVEL.length))
      return true
    }
  }
  return false
}

// Chronicle of Atzoatl, Expedition Logbook, Mirrored Tablet, Forbidden Tome
// (info.refName). Heist items and charts read area level in their own parsers.
function parseAreaLevel (section: string[], item: ParsedItem) {
  if (
    item.info.refName !== 'Chronicle of Atzoatl' &&
    item.info.refName !== 'Expedition Logbook' &&
    item.info.refName !== 'Mirrored Tablet' &&
    item.info.refName !== 'Forbidden Tome'
  ) return 'PARSER_SKIPPED'

  if (!parseAreaLevelNested(section, item)) {
    return 'SECTION_SKIPPED'
  }

  return 'SECTION_PARSED'
}

function parseAtzoatlRooms (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Chronicle of Atzoatl') return 'PARSER_SKIPPED'
  if (section[0] !== _$.INCURSION_OPEN) return 'SECTION_SKIPPED'

  let state = IncursionRoom.Open
  for (const line of section.slice(1)) {
    if (line === _$.INCURSION_OBSTRUCTED) {
      state = IncursionRoom.Obstructed
      continue
    }

    const found = STAT_BY_MATCH_STR(line)
    if (found) {
      item.newMods.push({
        info: { tags: [], type: ModifierType.Pseudo },
        stats: [{
          stat: found.stat,
          translation: {
            string: (state === IncursionRoom.Open)
              ? found.matcher.string
              : `${_$.INCURSION_OBSTRUCTED} ${found.matcher.string}`
          },
          roll: { value: state, min: state, max: state, dp: false, unscalable: true }
        }]
      })
    } else {
      item.unknownModifiers.push({
        text: line,
        type: ModifierType.Pseudo
      })
    }
  }

  return 'SECTION_PARSED'
}

function parseMirroredTablet (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Mirrored Tablet') return 'PARSER_SKIPPED'
  if (section.length < 8) return 'SECTION_SKIPPED'

  for (const line of section) {
    const found = tryParseTranslation({ string: line, unscalable: true }, ModifierType.Pseudo, undefined)
    if (found) {
      item.newMods.push({
        info: { tags: [], type: ModifierType.Pseudo },
        stats: [found]
      })
    } else {
      item.unknownModifiers.push({
        text: line,
        type: ModifierType.Pseudo
      })
    }
  }

  return 'SECTION_PARSED'
}

function parseFilledCoffin (section: string[], item: ParsedItem) {
  if (item.info.refName !== 'Filled Coffin') return 'PARSER_SKIPPED'
  if (!section.some(line => line.endsWith(IMPLICIT_LINE))) return 'SECTION_SKIPPED'

  const { lines } = parseModType(section)
  const modInfo: ModifierInfo = {
    type: ModifierType.Necropolis,
    tags: []
  }
  parseStatsFromMod(lines, item, { info: modInfo, stats: [] })

  return 'SECTION_PARSED'
}

function markupConditionParser (text: string) {
  // ignores state set by <<set:__>>
  // always evaluates first condition to true <if:__>{...}
  // full markup: https://gist.github.com/SnosMe/151549b532df8ea08025a76ae2920ca4

  text = text.replace(/<<set:.+?>>/g, '')
  text = text.replace(/<(if:.+?|elif:.+?|else)>{(.+?)}/g, (_, type: string, body: string) => {
    return type.startsWith('if:')
      ? body
      : ''
  })

  return text
}

function parseStatsFromMod (lines: string[], item: ParsedItem, modifier: ParsedModifier) {
  item.newMods.push(modifier)

  if (modifier.info.type === ModifierType.Veiled) {
    const found = STAT_BY_MATCH_STR(modifier.info.name!)
    if (found) {
      modifier.stats.push({
        stat: found.stat,
        translation: found.matcher
      })
    } else {
      item.unknownModifiers.push({
        text: modifier.info.name!,
        type: modifier.info.type
      })
    }
    return
  }

  const statIterator = linesToStatStrings(lines)
  let stat = statIterator.next()
  while (!stat.done) {
    const parsedStat = tryParseTranslation(stat.value, modifier.info.type, item.category)
    if (parsedStat) {
      modifier.stats.push(parsedStat)
      stat = statIterator.next(true)
    } else {
      stat = statIterator.next(false)
    }
  }

  item.unknownModifiers.push(...stat.value.map(line => ({
    text: line,
    type: modifier.info.type
  })))
}

// Post-step: reads isSynthesised, isCorrupted, isMirrored, rarity and
// category, so it runs after all section parsers.
function augmentModifiers (item: ParsedItem) {
  for (const mod of item.newMods) {
    if (item.isSynthesised && mod.info.type === ModifierType.Implicit) {
      mod.info.mechanic ??= ModifierMechanic.Synthesised
    }

    for (const stat of mod.stats) {
      if (stat.roll?.generation !== 'legacy' || stat.roll.unscalable) continue

      if (item.rarity === ItemRarity.Unique && item.isCorrupted) {
        stat.roll.generation = 'volatile'
      } else if (item.rarity === ItemRarity.Rare && item.isMirrored &&
        (item.category === ItemCategory.Ring || item.category === ItemCategory.Amulet)
      ) {
        stat.roll.generation = 'reflecting'
      }
    }
  }
}

/**
 * @deprecated
 */
function transformToLegacyModifiers (item: ParsedItem) {
  item.statsByType = sumStatsByModType(item.newMods)
}

// Post-step: needs uniqueBase from pickCorrectVariant.
function calcBasePercentile (item: ParsedItem) {
  const info = item.uniqueBase?.armour ?? item.info.armour
  if (!info) return

  // Base percentile is the same for all defences.
  // Using `AR/EV -> ES -> WARD` order to improve accuracy
  // of calculation (larger rolls = more precise).
  if (item.armourAR && info.ar) {
    item.basePercentile = calcPropPercentile(item.armourAR, info.ar, QUALITY_STATS.ARMOUR, item)
  } else if (item.armourEV && info.ev) {
    item.basePercentile = calcPropPercentile(item.armourEV, info.ev, QUALITY_STATS.EVASION, item)
  } else if (item.armourES && info.es) {
    item.basePercentile = calcPropPercentile(item.armourES, info.es, QUALITY_STATS.ENERGY_SHIELD, item)
  } else if (item.armourWARD && info.ward) {
    item.basePercentile = calcPropPercentile(item.armourWARD, info.ward, QUALITY_STATS.WARD, item)
  }
}

// Post-step: needs the final info from pickCorrectVariant; also called by makeIdentifiedUnique.
function calcDisenchantDust (item: ParsedItem) {
  if (!item.info.unique?.disenchantValue) return

  let increaseByFactors = 0

  // +50% per Influence Type
  increaseByFactors += item.influences.length * 50

  // +2% per 1% Item Quality
  if (item.quality) {
    increaseByFactors += item.quality * 2
  }

  // +50% per Corruption Implicit
  if (item.isCorrupted) {
    for (const mod of item.newMods) {
      if (mod.info.mechanic === ModifierMechanic.Corruption) {
        increaseByFactors += 50
      }
    }
  }

  const factorsMulti = (increaseByFactors + 100) / 100
  const term1 = 50 // ilvl 46 and below
  const term2 = 2 * (Math.min(Math.max(item.itemLevel!, 46), 68) - 46) // ilvl 47 to 68
  const term3 = Math.floor(3 * (Math.min(Math.max(item.itemLevel!, 46), 68) - 46) / 11) // ilvl 47 to 68
  const term4 = 25 * (Math.min(Math.max(item.itemLevel!, 68), 84) - 68) // ilvl 69 to 84
  const totalMulti = 5 * (term1 + term2 + term3 + term4) * factorsMulti

  item.dustEquivalent = Math.floor(item.info.unique.disenchantValue * totalMulti)
}
