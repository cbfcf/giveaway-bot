
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

const dataDir = fs.existsSync("/data") ? "/data" : __dirname;
const dataFile = path.join(dataDir, "giveaways.json");

let giveaways = {};

try {
  giveaways = JSON.parse(fs.readFileSync(dataFile, "utf8"));
} catch {
  giveaways = {};
}

function save() {
  fs.writeFileSync(dataFile, JSON.stringify(giveaways, null, 2));
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const commands = [
  new SlashCommandBuilder()
    .setName("gstart")
    .setDescription("Start a giveaway")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("prize").setDescription("Giveaway prize").setRequired(true))
    .addStringOption(o =>
      o.setName("duration").setDescription("Example: 10m, 2h, 1d").setRequired(true))
    .addIntegerOption(o =>
      o.setName("winners").setDescription("Number of winners").setMinValue(1).setMaxValue(20).setRequired(true)),

  new SlashCommandBuilder()
    .setName("gend")
    .setDescription("End a giveaway early")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),

  new SlashCommandBuilder()
    .setName("greroll")
    .setDescription("Pick a new giveaway winner")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName("message_id").setDescription("Giveaway message ID").setRequired(true))
].map(c => c.toJSON());

function durationMs(value) {
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

  const result = amount * units[match[2].toLowerCase()];
  if (!Number.isSafeInteger(result) || result < 10000 || result > 365 * 86400000) return null;
  return result;
}

function pickWinners(entries, count) {
  const pool = [...entries];
  const winners = [];

  while (pool.length && winners.length < count) {
    const index = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(index, 1)[0]);
  }

  return winners;
}

function giveawayEmbed(g, ended = false) {
  return new EmbedBuilder()
    .setColor(ended ? 0x777777 : 0x5865F2)
    .setTitle("🎉 " + g.prize)
    .setDescription(
      (ended ? "**GIVEAWAY ENDED**" : "**React with the button below to enter!**") +
      "\n\nWinners: **" + g.winnerCount + "**" +
      "\nEntries: **" + g.entries.length + "**" +
      (ended ? "" : "\nEnds: <t:" + Math.floor(g.endAt / 1000) + ":R>")
    )
    .setFooter({ text: "Giveaway Bot" });
}

function giveawayRow(g, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("giveaway_enter:" + g.messageId)
      .setLabel("Enter giveaway (" + g.entries.length + ")")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled)
  );
}

async function finishGiveaway(g) {
  if (g.ended) return;

  g.ended = true;
  save();

  const channel = await client.channels.fetch(g.channelId).catch(() => null);
  if (!channel) return;

  const message = await channel.messages.fetch(g.messageId).catch(() => null);
  if (message) {
    await message.edit({
      embeds: [giveawayEmbed(g, true)],
      components: [giveawayRow(g, true)]
    }).catch(() => {});
  }

  const winners = pickWinners(g.entries, g.winnerCount);

  if (!winners.length) {
    await channel.send("Nobody entered the **" + g.prize + "** giveaway. No winner was selected.");
  } else {
    await channel.send(
      "🎉 Congratulations " +
      winners.map(id => "<@" + id + ">").join(", ") +
      "! You won **" + g.prize + "**!"
    );
  }
}

function scheduleGiveaway(g) {
  if (g.ended) return;

  const remaining = g.endAt - Date.now();

  setTimeout(async () => {
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

  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );

  console.log("Giveaway commands registered.");

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

    const messageId = interaction.customId.split(":")[1];
    const g = giveaways[messageId];

    if (!g || g.ended) {
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

    save();

    await interaction.update({
      embeds: [giveawayEmbed(g)],
      components: [giveawayRow(g)]
    });

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "gstart") {
    const prize = interaction.options.getString("prize");
    const duration = durationMs(interaction.options.getString("duration"));
    const winnerCount = interaction.options.getInteger("winners");

    if (!duration) {
      return interaction.reply({
        content: "Invalid duration. Use 10m, 2h, 1d or 1w. Minimum is 10 seconds.",
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

    const message = await interaction.channel.send({
      embeds: [giveawayEmbed(g)],
      components: [giveawayRow(g)]
    });

    g.messageId = message.id;
    giveaways[message.id] = g;
    save();
    scheduleGiveaway(g);

    return interaction.reply({
      content: "Giveaway started! " + message.url,
      ephemeral: true
    });
  }

  if (interaction.commandName === "gend") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || g.ended) {
      return interaction.reply({
        content: "I couldn't find an active giveaway with that message ID.",
        ephemeral: true
      });
    }

    await finishGiveaway(g);

    return interaction.reply({
      content: "Giveaway ended!",
      ephemeral: true
    });
  }

  if (interaction.commandName === "greroll") {
    const id = interaction.options.getString("message_id");
    const g = giveaways[id];

    if (!g || !g.ended) {
      return interaction.reply({
        content: "That giveaway doesn't exist or hasn't ended yet.",
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

client.login(TOKEN);
        
