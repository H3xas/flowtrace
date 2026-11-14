describe('console settings', () => {
  it('renders the settings screen', () => {
    cy.intercept('GET', '/lanterns/v1/settings');
    cy.visit('/settings');
  });
});
