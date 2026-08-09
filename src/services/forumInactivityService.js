import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionFlagsBits } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { logger } from '../utils/logger.js';

const INACTIVITY_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minuten
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export function startForumInactivityChecker(client) {
  setInterval(() => checkForumInactivity(client), INACTIVITY_CHECK_INTERVAL);
}

async function checkForumInactivity(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(client, guild.id);
      const managedChannels = config.forumManagement?.channels || [];

      if (!managedChannels.length) continue;

      for (const channelId of managedChannels) {
        const channel = await guild.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildForum) continue;

        const activeThreads = await channel.threads.fetchActive().catch(() => null);
        if (!activeThreads) continue;

        for (const thread of activeThreads.threads.values()) {
          if (thread.locked) continue;
          await processThreadInactivity(thread);
        }
      }
    } catch (error) {
      logger.error(`Fout bij forum inactiviteitscontrole in guild ${guild.id}:`, error);
    }
  }
}

async function processThreadInactivity(thread) {
  try {
    const messages = await thread.messages.fetch({ limit: 1 }).catch(() => null);
    const lastMessage = messages?.first();
    if (!lastMessage) return;

    const now = Date.now();
    const timeSinceLastMsg = now - lastMessage.createdTimestamp;

    const isPromptMessage = lastMessage.author.id === thread.client.user.id &&
      lastMessage.embeds.length > 0 &&
      lastMessage.embeds[0].title === 'Inactive Forum Post';

    // 24 uur geen reactie op de herinnerings-embed -> Auto Lock
    if (isPromptMessage) {
      if (timeSinceLastMsg >= TWENTY_FOUR_HOURS) {
        await resolveForumThread(thread, false);
      }
      return;
    }

    // 48 uur geen activiteit -> Stuur herinnerings-embed
    if (timeSinceLastMsg >= FORTY_EIGHT_HOURS) {
      const embed = new EmbedBuilder()
        .setTitle('Inactive Forum Post')
        .setDescription('Hello, this post seems to be inactive. Has your issue been solved?')
        .setFooter({ text: 'Selecting No resets the 24-hour inactivity timer.' })
        .setTimestamp(lastMessage.createdTimestamp)
        .setColor('#D97706');

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`forum_solved_${thread.id}`)
          .setLabel('Yes, my issue has been solved')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`forum_not_solved_${thread.id}`)
          .setLabel("No, it hasn't")
          .setStyle(ButtonStyle.Secondary)
      );

      await thread.send({
        content: `<@${thread.ownerId}>`,
        embeds: [embed],
        components: [row]
      });
    }
  } catch (err) {
    logger.error(`Fout bij verwerken van thread ${thread.id}:`, err);
  }
}

export async function handleForumButton(interaction, client) {
  const { customId, channel: thread, user, member } = interaction;
  if (!thread || !thread.isThread()) return;

  const isOwner = thread.ownerId === user.id;
  const isMod = member.permissions.has(PermissionFlagsBits.ManageThreads);

  if (!isOwner && !isMod) {
    return await interaction.reply({
      content: '❌ Alleen de maker van deze post kan op deze knop drukken.',
      ephemeral: true
    });
  }

  if (customId.startsWith('forum_solved_')) {
    await interaction.update({ components: [] });
    await resolveForumThread(thread, true);
  } else if (customId.startsWith('forum_not_solved_')) {
    await interaction.update({ components: [] });
    await thread.send('Okay — this post will remain open. I will check again after another 24 hours of inactivity.');
  }
}

export async function resolveForumThread(thread, isResolvedByChoice = true) {
  try {
    const parent = thread.parent;

    // Tag toevoegen als deze in het forum aanwezig is
    if (isResolvedByChoice && parent?.availableTags?.length > 0) {
      const resolvedTag = parent.availableTags.find(tag =>
        tag.name.toLowerCase().includes('solved') || tag.name.toLowerCase().includes('resolved')
      );

      if (resolvedTag && !thread.appliedTags.includes(resolvedTag.id)) {
        await thread.setAppliedTags([...thread.appliedTags, resolvedTag.id]).catch(() => null);
      }
    }

    await thread.setLocked(true);

    if (isResolvedByChoice) {
      await thread.send('# Locked - Resolved\nThis post has been resolved.');
    } else {
      await thread.send('# Locked - Inactive\nThis post was automatically locked because there was no response to the inactivity check within 24 hours.');
    }
  } catch (error) {
    logger.error(`Fout bij sluiten van forum thread ${thread.id}:`, error);
  }
}