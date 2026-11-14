export class SettingsPage {
  visit() {
    cy.visit('/settings');
  }

  stubSettings() {
    cy.intercept('GET', '/lanterns/v1/settings');
  }

  stubAudit() {
    cy.intercept('GET', '/lanterns/v1/audit');
  }
}
