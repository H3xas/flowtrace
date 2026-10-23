describe('site list', () => {
  it('lists the dive sites', () => {
    cy.intercept('GET', '**/reef/v1/sites').as('sites');
    cy.visit('/sites');
    cy.wait('@sites');
  });
});
