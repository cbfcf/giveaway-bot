
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require("discord.js");

const fs = require("node:fs");
const path = require("node:path");

// CONFIGURATION
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error("Missing bot environment variables.");
}

// DATABASE
const DATA_FILE = path.join(__dirname, "giveaways.json");

let giveaways = {};

function saveData() {
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(giveaways, null, 2));
  fs.renameSync(temp, DATA_FILE);
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      giveaways = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    }
  } catch (error) {
    console.error("Database error:", error);
    giveaways = {};
  }

  if (!giveaways || typeof giveaways !== "object" || Array.isArray(giveaways)) {
    giveaways = {};
  }

  for (const g of Object.values(giveaways)) {
    if (!Array.isArray(g.entries)) g.entries = [];
    g.entries = [...new Set(g.entries.filter(id => typeof id === "string"))];
    if (typeof g.ended !== "boolean") g.ended = false;
  }

  saveData();
}

loadData();

// DISCORD CLIENT
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

// SLASH COMMANDS
const commands = [
  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("prize")
        .setDescription("Giveaway prize")
        .setRequired(true))
    .addStringOption(o =>
      o.setName("duration")
        .setDescription("Example: 10m, 2h, 1d")
        .setRequired(true))
    .addIntegerOption(o =>
      o.setName("winners")
        .setDescription("Number of winners")
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("message_id")
        .setDescription("Giveaway message ID")
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("message_id")
        .setDescription("Giveaway message ID")
        .setRequired(true))
].map(c => c.toJSON());

// DURATION
function parseDuration(value) {
  const match = value.trim().match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;

  const units = {
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
    w: 604800000
  };

  const result = Number(match[1]) * units[match[2].toLowerCase()];

  if (!Number.isSafeInteger(result) ||
      result < 10000 ||
      result > 365 * 86400000) return null;

  return result;
}

// WINNER SELECTION
function pickWinners(entries, amount) {
  const pool = [...new Set(
    (Array.isArray(entries) ? entries : [])
      .filter(id => typeof id === "string" && /^\d+$/.test(id))
  )];

  const winners = [];

  while (pool.length && winners.length < amount) {
    const index = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }

  return winners;
}

// V2 BUTTONS
function makeButtons(g, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter:" + g.messageId)
      .setLabel("Enter Giveaway • " + g.entries.length)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

// V2 GIVEAWAY CONTAINER
function makeGiveaway(g, ended = false) {
  const container = new ContainerBuilder()
    .setAccentColor(ended ? 0x777777 : 0x5865F2)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        ended ? "# GIVEAWAY ENDED" : "# 🎉 GIVEAWAY"
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## " + g.prize +
        "\n\n" +
        (ended
          ? "**This giveaway has ended.**"
          : "Enter below for a chance to win!")
      )
    )
    .addSeparatorComponents(
      new SeparatorBuilder()
        .setDivider(true)
        .setSpacing(SeparatorSpacingSize.Small)
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "**Winners:** " + g.winnerCount +
        "\n**Entries:** " + g.entries.length +
        (ended
          ? ""
          : "\n**Ends:** <t:" + Math.floor(g.endAt / 1000) + ":R>")
      )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "-# Giveaway Bot"
      )
    );

  container.addActionRowComponents(makeButtons(g, ended));

  return container;
}

// UPDATE GIVEAWAY MESSAGE
async function updateGiveaway(g, ended = false) {
  const channel = await client.channels.fetch(g.channelId).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    console.error("Giveaway channel unavailable:", g.channelId);
    return;
  }

  const message = await channel.messages.fetch(g.messageId).catch(() => null);

  if (!message) {
    console.error("Giveaway message unavailable:", g.messageId);
    return;
  }

  await message.edit({
    components: [makeGiveaway(g, ended)]
  });
}

// END GIVEAWAY
async function finishGiveaway(g) {
  if (!g || g.ended || g.ending) return;

  g.ending = true;
  saveData();

  try {
    // Read the latest saved entries.
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

      if (saved[g.messageId] &&
          Array.isArray(saved[g.messageId].entries)) {
        g.entries = [...new Set(saved[g.messageId].entries)];
      }
    }

    const winners = pickWinners(g.entries, g.winnerCount);

    g.ended = true;
    g.ending = false;
    g.winners = winners;
    saveData();

    await updateGiveaway(g, true);

    const channel = await client.channels.fetch(g.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    if (!winners.length) {
      await channel.send("Nobody entered the **" + g.prize + "** giveaway.");
    } else {
      await channel.send(
        "🎉 Congratulations " +
        winners.map(id => "<@" + id + ">").join(", ") +
        "! You won **" + g.prize + "**!"
      );
    }

    console.log("Giveaway ended:", g.messageId,
      "Entries:", g.entries.length, "Winners:", winners);

  } catch (error) {
    g.ending = false;
    saveData();
    console.error("Ending error:", error);
  }
}

// AUTOMATIC TIMER
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

// BOT READY
client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);

  try {
    const rest = new REST({ version: "10" }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("Giveaway commands registered.");
  } catch (error) {
    console.error("Command registration error:", error);
    return;
  }

  for (const g of Object.values(giveaways)) {
    if (g.ended) continue;

    if (Date.now() >= g.endAt) {
      await finishGiveaway(g);
    } else {
      scheduleGiveaway(g);
    }
  }

  console.log("Active giveaways loaded.");
});

// INTERACTIONS
client.on("interactionCreate", async interaction => {

  // GIVEAWAY BUTTON
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("giveaway_enter:")) return;

    const messageId = interaction.customId.slice("giveaway_enter:".length);
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

    if (!Array.isArray(g.entries)) g.entries = [];

    const userId = interaction.user.id;
    const index = g.entries.indexOf(userId);

    let response;

    if (index === -1) {
      g.entries.push(userId);
      response = "You successfully entered the giveaway!";
    } else {
      g.entries.splice(index, 1);
      response = "You left the giveaway.";
    }

    saveData();

    console.log("Entry update:", messageId, g.entries.length, g.entries);

    await interaction.update({
      components: [makeGiveaway(g)]
    });

    await interaction.followUp({
      content: response,
      ephemeral: true
    }).catch(console.error);

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // START
  if (interaction.commandName === "gstart") {
    const prize = interaction.options.getString("prize");
    const duration = parseDuration(interaction.options.getString("duration"));
    const winnerCount = interaction.options.getInteger("winners");

    if (!duration) {
      return interaction.reply({
        content: "Invalid duration. Use 10m, 2h, 1d or 1w.",
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

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

    // Send V2 container first.
    const message = await interaction.channel.send({
      components: [
        new ContainerBuilder()
          .setAccentColor(0x5865F2)
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("# 🎉 GIVEAWAY\n\nCreating giveaway...")
          )
      ],
      flags: MessageFlags.IsComponentsV2
    });

    g.messageId = message.id;
    giveaways[message.id] = g;
    saveData();

    // Now the real message ID is available for the button.
    await message.edit({
      components: [makeGiveaway(g)]
    });

    scheduleGiveaway(g);

    await interaction.editReply({
      content: "Giveaway started! " + message.url
    });

    return;
  }

  // END
  if (interaction.commandName === "gend") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || g.ended) {
      return interaction.reply({
        content: "Active giveaway not found.",
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });
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

    const winners = pickWinners(g.entries, g.winnerCount);

    if (!winners.length) {
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

    return interaction.reply({
      content: "Winner rerolled!",
      ephemeral: true
    });
  }
});

// LOGIN
client.login(TOKEN);
      
