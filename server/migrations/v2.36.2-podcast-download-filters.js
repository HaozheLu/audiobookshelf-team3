const { DataTypes } = require('sequelize')

const columns = {
  excludeTrailers: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  excludeBonusEpisodes: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  excludeTitlePhrase: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' }
}

/**
 * @param {{ context: { queryInterface: import('sequelize').QueryInterface, logger: import('../Logger') } }} options
 */
async function up({ context: { queryInterface, logger } }) {
  if (!(await queryInterface.tableExists('podcasts'))) return
  await queryInterface.sequelize.transaction(async (transaction) => {
    const existing = await queryInterface.describeTable('podcasts', { transaction })
    for (const [column, definition] of Object.entries(columns)) {
      if (existing[column]) continue
      logger.info(`[2.36.2 migration] Adding podcasts.${column}`)
      await queryInterface.addColumn('podcasts', column, definition, { transaction })
    }
  })
}

/**
 * @param {{ context: { queryInterface: import('sequelize').QueryInterface, logger: import('../Logger') } }} options
 */
async function down({ context: { queryInterface, logger } }) {
  if (!(await queryInterface.tableExists('podcasts'))) return
  await queryInterface.sequelize.transaction(async (transaction) => {
    const existing = await queryInterface.describeTable('podcasts', { transaction })
    for (const column of Object.keys(columns)) {
      if (!existing[column]) continue
      logger.info(`[2.36.2 migration] Removing podcasts.${column}`)
      // Native SQLite DROP COLUMN preserves unrelated indexes, triggers and references.
      // Sequelize's SQLite removeColumn rebuilds the table instead.
      await queryInterface.sequelize.query(`ALTER TABLE "podcasts" DROP COLUMN "${column}"`, { transaction })
    }
  })
}

module.exports = { up, down }
