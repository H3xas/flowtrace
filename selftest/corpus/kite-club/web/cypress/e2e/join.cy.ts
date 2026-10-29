describe('joining a club', () => {
  it('posts the join request', () => {
    cy.intercept('POST', '**/clubs/v1/join/*').as('join');
    cy.visit('/kites/clubs/c1');
    cy.contains('Join').click();
    cy.wait('@join');
  });
});
