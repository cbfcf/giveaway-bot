
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

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error("Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID.");
}

const DATA_FILE = path.join(__dirname, "giveaways.json");

let giveaways = {};

try {
  if (fs.existsSync(DATA_FILE)) {
    giveaways = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch (error) {
  console.error("Could not load giveaway data:", error);
  giveaways = {};
}

function saveGiveaways() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(giveaways, null, 2));
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option.setName("prize")
        .setDescription("The giveaway prize")
        .setRequired(true))
    .addStringOption(option =>
      option.setName("duration")
        .setDescription("Example: 10m, 2h, 1d")
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName("winners")
        .setDescription("Number of winners")
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway early")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option.setName("message_id")
        .setDescription("Giveaway message ID")
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Reroll a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option =>
      option.setName("message_id")
        .setDescription("Giveaway message ID")
        .setRequired(true))
].map(command => command.toJSON());

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

  const duration = amount * units[match[2].toLowerCase()];

  if (
    !Number.isSafeInteger(duration) ||
    duration < 10000 ||
    duration > 365 * 86400000
  ) return null;

  return duration;
}

function pickWinners(entries, count) {
  const pool = [...new Set(entries)];
  const winners = [];

  while (pool.length > 0 && winners.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }

  return winners;
}

function makeEmbed(g, ended = false) {
  const embed = new EmbedBuilder()
    .setColor(ended ? 0x777777 : 0x5865F2)
    .setTitle("🎉 " + g.prize)
    .setDescription(
      (ended
        ? "**GIVEAWAY ENDED**"
        : "**Press the button below to enter!**") +
      "\n\nWinners: **" + g.winnerCount + "**" +
      "\nEntries: **" + g.entries.length + "**" +
      (ended
        ? ""
        : "\nEnds: <t:" + Math.floor(g.endAt / 1000) + ":R>")
    )
    .setFooter({ text: "Giveaway Bot" });

  return embed;
}

function makeButton(g, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter:" + g.messageId)
      .setLabel("Enter giveaway (" + g.entries.length + ")")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

async function finishGiveaway(g) {
  if (!g || g.ended) return;

  g.ended = true;
  saveGiveaways();

  const channel = await client.channels
    .fetch(g.channelId)
    .catch(() => null);

  if (!channel || !channel.isTextBased()) return;

  const message = await channel.messages
    .fetch(g.messageId)
    .catch(() => null);

  if (message) {
    await message.edit({
      embeds: [makeEmbed(g, true)],
      components: [makeButton(g, true)]
    }).catch(console.error);
  }

  const winners = pickWinners(g.entries, g.winnerCount);

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
}

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

client.once("ready", async () => {
  console.log("Logged in as " + client.user.tag);

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );

    console.log("Giveaway commands registered.");
  } catch (error) {
    console.error("Command registration failed:", error);
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
});

client.on("interactionCreate", async interaction => {
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("giveaway_enter:")) return;

    const messageId = interaction.customId.slice(
      "giveaway_enter:".length
    );

    const g = giveaways[messageId];

    if (!g || g.ended) {
      return interaction.reply({
        content: "This giveaway is no longer active.",
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

    const userId = interaction.user.id;
    const index = g.entries.indexOf(userId);

    if (index === -1) {
      g.entries.push(userId);
    } else {
      g.entries.splice(index, 1);
    }

    saveGiveaways();

    await interaction.update({
      embeds: [makeEmbed(g)],
      components: [makeButton(g)]
    });

    return;
  }

  if (!interaction.isChatInputCommand()) return;

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
      ended: false
    };

    // Create the message BEFORE creating its entry button.
    const message = await interaction.channel.send({
      embeds: [makeEmbed(g)]
    });

    // Save the real Discord message ID.
    g.messageId = message.id;
    giveaways[message.id] = g;
    saveGiveaways();

    // Now create a button using the correct message ID.
    await message.edit({
      embeds: [makeEmbed(g)],
      components: [makeButton(g)]
    });

    scheduleGiveaway(g);

    return interaction.reply({
      content: "Giveaway successfully started! " + message.url,
      ephemeral: true
    });
  }

  if (interaction.commandName === "gend") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || g.ended) {
      return interaction.reply({
        content: "Active giveaway not found.",
        ephemeral: true
      });
    }

    await finishGiveaway(g);

    return interaction.reply({
      content: "Giveaway ended successfully!",
      ephemeral: true
    });
  }

  if (interaction.commandName === "greroll") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || !g.ended) {
      return interaction.reply({
        content: "Giveaway not found or it has not ended.",
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
      content: "Winner successfully rerolled!",
      ephemeral: true
    });
  }
});

client.login(TOKEN);
  
