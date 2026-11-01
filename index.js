
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");

// ================================
// CONFIGURATION
// ================================

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Set DATA_DIR to your FadeHost persistent storage directory.
// If unset, data is stored beside this file.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "giveaways.json");

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID environment variables."
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ================================
// DATABASE
// ================================

let giveaways = {};

function loadGiveaways() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(
        fs.readFileSync(DATA_FILE, "utf8")
      );

      giveaways =
        data && typeof data === "object" && !Array.isArray(data)
          ? data
          : {};
    }
  } catch (error) {
    console.error("Database loading error:", error);
    giveaways = {};
  }

  for (const g of Object.values(giveaways)) {
    if (!Array.isArray(g.entries)) {
      g.entries = [];
    }

    g.entries = [...new Set(g.entries.filter(
      id => typeof id === "string"
    ))];

    if (typeof g.ended !== "boolean") {
      g.ended = false;
    }

    if (typeof g.ending !== "boolean") {
      g.ending = false;
    }
  }

  saveGiveaways();
}

function saveGiveaways() {
  const temporaryFile = DATA_FILE + ".tmp";

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(giveaways, null, 2)
  );

  fs.renameSync(temporaryFile, DATA_FILE);
}

loadGiveaways();

// ================================
// DISCORD CLIENT
// ================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// ================================
// SLASH COMMANDS
// ================================

const commands = [
  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addStringOption(option =>
      option
        .setName("prize")
        .setDescription("Giveaway prize")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("duration")
        .setDescription("Example: 10m, 2h, 1d")
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option
        .setName("winners")
        .setDescription("Number of winners")
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway early")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addStringOption(option =>
      option
        .setName("message_id")
        .setDescription("Giveaway message ID")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway winner")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addStringOption(option =>
      option
        .setName("message_id")
        .setDescription("Giveaway message ID")
        .setRequired(true)
    )
].map(command => command.toJSON());

// ================================
// DURATION SYSTEM
// ================================

function parseDuration(value) {
  const match = value.trim().match(/^(\d+)(s|m|h|d|w)$/i);

  if (!match) return null;

  const amount = Number(match[1]);

  const units = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000
  };

  const duration =
    amount * units[match[2].toLowerCase()];

  if (
    !Number.isSafeInteger(duration) ||
    duration < 10000 ||
    duration > 365 * 86400000
  ) {
    return null;
  }

  return duration;
}

// ================================
// WINNER SELECTION
// ================================

function pickWinners(entries, amount) {
  const pool = [
    ...new Set(
      (Array.isArray(entries) ? entries : [])
        .filter(id =>
          typeof id === "string" && /^\d+$/.test(id)
        )
    )
  ];

  const winners = [];

  while (pool.length > 0 && winners.length < amount) {
    const index = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }

  return winners;
}

// ================================
// GIVEAWAY DISPLAY
// ================================

function makeEmbed(g, ended = false) {
  return new EmbedBuilder()
    .setColor(ended ? 0x777777 : 0x5865F2)
    .setTitle("🎉 " + g.prize)
    .setDescription(
      (ended
        ? "**GIVEAWAY ENDED**"
        : "**Press the button below to enter or leave!**") +
      "\n\nWinners: **" + g.winnerCount + "**" +
      "\nEntries: **" + g.entries.length + "**" +
      (ended
        ? ""
        : "\nEnds: <t:" + Math.floor(g.endAt / 1000) + ":R>")
    )
    .setFooter({
      text: "Giveaway Bot"
    });
}

function makeButtons(g, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter:" + g.messageId)
      .setLabel("Enter Giveaway (" + g.entries.length + ")")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

// ================================
// UPDATE GIVEAWAY MESSAGE
// ================================

async function updateGiveawayMessage(g, ended = false) {
  const channel = await client.channels
    .fetch(g.channelId)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) {
    console.error("Giveaway channel not found:", g.channelId);
    return;
  }

  const message = await channel.messages
    .fetch(g.messageId)
    .catch(() => null);

  if (!message) {
    console.error("Giveaway message not found:", g.messageId);
    return;
  }

  await message.edit({
    embeds: [makeEmbed(g, ended)],
    components: [makeButtons(g, ended)]
  });
}

// ================================
// END GIVEAWAY
// ================================

async function finishGiveaway(g) {
  if (!g || g.ended || g.ending) return;

  g.ending = true;
  saveGiveaways();

  try {
    // Read the latest stored entries before picking.
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(
        fs.readFileSync(DATA_FILE, "utf8")
      );

      if (
        saved[g.messageId] &&
        Array.isArray(saved[g.messageId].entries)
      ) {
        g.entries = [
          ...new Set(saved[g.messageId].entries)
        ];
      }
    }

    const winners = pickWinners(
      g.entries,
      g.winnerCount
    );

    g.ended = true;
    g.ending = false;
    g.winners = winners;
    g.endedAt = Date.now();

    saveGiveaways();

    await updateGiveawayMessage(g, true);

    const channel = await client.channels
      .fetch(g.channelId)
      .catch(() => null);

    if (!channel || !channel.isTextBased()) return;

    if (winners.length === 0) {
      await channel.send(
        "Nobody entered the **" + g.prize + "** giveaway."
      );
    } else {
      await channel.send(
        "🎉 Congratulations " +
        winners.map(id => "<@" + id + ">").join(", ") +
        "! You won **" + g.prize + "**!"
      );
    }

    console.log(
      "Giveaway ended:",
      g.messageId,
      "Entries:",
      g.entries.length,
      "Winners:",
      winners
    );

  } catch (error) {
    g.ending = false;
    saveGiveaways();

    console.error("Giveaway ending error:", error);
  }
}

// ================================
// AUTOMATIC TIMER
// ================================

function scheduleGiveaway(g) {
  if (!g || g.ended) return;

  const remaining = g.endAt - Date.now();

  setTimeout(async () => {
    if (g.ended) return;

    if (Date.now() >= g.endAt) {
      await finishGiveaway(g);
    } else {
      scheduleGiveaway(g);
    }
  }, Math.min(Math.max(remaining, 0), 2147483647));
}

// ================================
// BOT READY
// ================================

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);

  try {
    const rest = new REST({
      version: "10"
    }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(
        CLIENT_ID,
        GUILD_ID
      ),
      {
        body: commands
      }
    );

    console.log("Giveaway commands registered.");

  } catch (error) {
    console.error("Command registration error:", error);
    return;
  }

  for (const g of Object.values(giveaways)) {
    if (!g.ended) {
      if (Date.now() >= g.endAt) {
        await finishGiveaway(g);
      } else {
        scheduleGiveaway(g);
      }
    }
  }

  console.log(
    "Loaded " +
    Object.values(giveaways).filter(g => !g.ended).length +
    " active giveaways."
  );
});

// ================================
// INTERACTIONS
// ================================

client.on("interactionCreate", async interaction => {

  // GIVEAWAY BUTTON
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("giveaway_enter:")) {
      return;
    }

    const messageId = interaction.customId.slice(
      "giveaway_enter:".length
    );

    const g = giveaways[messageId];

    if (!g || g.ended) {
      return interaction.reply({
        content: "This giveaway has ended or cannot be found.",
        ephemeral: true
      });
    }

    if (Date.now() >= g.endAt) {
      await finishGiveaway(g);

      return interaction.reply({
        content: "This giveaway has ended.",
        ephemeral: true
      });
    }

    if (!Array.isArray(g.entries)) {
      g.entries = [];
    }

    const userId = interaction.user.id;

    const index = g.entries.indexOf(userId);

    let response;

    if (index === -1) {
      g.entries.push(userId);
      response = "You successfully entered the giveaway! 🎉";
    } else {
      g.entries.splice(index, 1);
      response = "You left the giveaway.";
    }

    saveGiveaways();

    console.log(
      "Entry update:",
      messageId,
      "Entries:",
      g.entries.length,
      g.entries
    );

    await interaction.update({
      embeds: [makeEmbed(g)],
      components: [makeButtons(g)]
    });

    // Send a private confirmation.
    await interaction.followUp({
      content: response,
      ephemeral: true
    }).catch(console.error);

    return;
  }

  // SLASH COMMANDS
  if (!interaction.isChatInputCommand()) return;

  // START GIVEAWAY
  if (interaction.commandName === "gstart") {
    const prize = interaction.options.getString("prize");
    const duration = parseDuration(
      interaction.options.getString("duration")
    );
    const winnerCount = interaction.options.getInteger("winners");

    if (!duration) {
      return interaction.reply({
        content: "Invalid duration. Use 10m, 2h, 1d or 1w.",
        ephemeral: true
      });
    }

    const g = {
      prize,
      winnerCount,
      endAt: Date.now() + duration,
      entries: [],
      channelId: interaction.channelId,
      messageId: null,
      ended: false,
      ending: false,
      winners: []
    };

    await interaction.deferReply({
      ephemeral: true
    });

    // Create the message first.
    const message = await interaction.channel.send({
      embeds: [makeEmbed(g)]
    });

    // Save the real message ID.
    g.messageId = message.id;
    giveaways[message.id] = g;

    saveGiveaways();

    // Add the entry button.
    await message.edit({
      embeds: [makeEmbed(g)],
      components: [makeButtons(g)]
    });

    scheduleGiveaway(g);

    await interaction.editReply({
      content: "Giveaway successfully started! " + message.url
    });

    console.log("New giveaway:", message.id);

    return;
  }

  // END GIVEAWAY
  if (interaction.commandName === "gend") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || g.ended) {
      return interaction.reply({
        content: "Active giveaway not found.",
        ephemeral: true
      });
    }

    await interaction.deferReply({
      ephemeral: true
    });

    await finishGiveaway(g);

    await interaction.editReply({
      content: "Giveaway ended!"
    });

    return;
  }

  // REROLL
  if (interaction.commandName === "greroll") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || !g.ended) {
      return interaction.reply({
        content: "Giveaway not found or hasn't ended.",
        ephemeral: true
      });
    }

    const winners = pickWinners(
      g.entries,
      g.winnerCount
    );

    if (winners.length === 0) {
      return interaction.reply({
        content: "There are no entries to reroll.",
        ephemeral: true
      });
    }

    await interaction.channel.send(
      "🎉 New winner: " +
      winners.map(id => "<@" + id + ">").join(", ") +
      "! You won **" + g.prize + "**!"
    );

    await interaction.reply({
      content: "Winner successfully rerolled!",
      ephemeral: true
    });

    return;
  }
});

// ================================
// LOGIN
// ================================

client.login(TOKEN);
      
