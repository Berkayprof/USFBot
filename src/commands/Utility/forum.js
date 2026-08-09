import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { patchGuildConfig, getGuildConfig } from '../../services/config/guildConfig.js';
import { resolveForumThread } from '../../services/forumInactivityService.js';

export default {
  category: 'Utility',
  data: new SlashCommandBuilder()
    .setName('forum')
    .setDescription('Forum management settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand(sub =>
      sub.setName('setup')
        .setDescription('Add or remove a forum channel for inactivity monitoring')
        .addChannelOption(opt =>
          opt.setName('channel')
            .setDescription('The forum channel')
            .addChannelTypes(ChannelType.GuildForum)
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('solved')
        .setDescription('Mark the current forum post as resolved')
    )
    .addSubcommand(sub =>
      sub.setName('resolved')
        .setDescription('Mark the current forum post as resolved')
    ),

  async execute(interaction, guildConfig, client) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'setup') {
      const channel = interaction.options.getChannel('channel');
      const config = guildConfig || await getGuildConfig(client, interaction.guildId);
      
      let forumChannels = config.forumManagement?.channels || [];

      if (forumChannels.includes(channel.id)) {
        forumChannels = forumChannels.filter(id => id !== channel.id);
        await patchGuildConfig(client, interaction.guildId, {
          forumManagement: { channels: forumChannels }
        });
        return await interaction.reply({
          content: `✅ Forum channel ${channel} has been **removed** from inactivity management.`,
          ephemeral: true
        });
      } else {
        forumChannels.push(channel.id);
        await patchGuildConfig(client, interaction.guildId, {
          forumManagement: { channels: forumChannels }
        });
        return await interaction.reply({
          content: `✅ Forum channel ${channel} has been **added** to inactivity management.`,
          ephemeral: true
        });
      }
    }

    if (subcommand === 'solved' || subcommand === 'resolved') {
      const thread = interaction.channel;
      if (!thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
        return await interaction.reply({
          content: '❌ This command can only be used inside a forum post.',
          ephemeral: true
        });
      }

      const isOwner = thread.ownerId === interaction.user.id;
      const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageThreads);

      if (!isOwner && !isMod) {
        return await interaction.reply({
          content: '❌ Only the author of the post or a moderator can use this command.',
          ephemeral: true
        });
      }

      await interaction.reply({ content: '🔒 Post is being resolved and locked...' });
      await resolveForumThread(thread, true);
    }
  }
};