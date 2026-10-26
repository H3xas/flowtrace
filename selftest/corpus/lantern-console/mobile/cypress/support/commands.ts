Cypress.Commands.add('stubSettings', () => {
  cy.intercept('GET', '/lanterns/v1/settings');
});
