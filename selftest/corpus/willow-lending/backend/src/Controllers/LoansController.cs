using Microsoft.AspNetCore.Mvc;
using WillowLending.Api.Services;

namespace WillowLending.Api.Controllers
{
    [ApiController]
    [Route("lending/v1")]
    public class LoansController : ControllerBase
    {
        private readonly ILoanService _loans;

        public LoansController(ILoanService loans)
        {
            _loans = loans;
        }

        [HttpGet("loans/{loanId}")]
        public IActionResult GetLoan(string loanId)
        {
            if (string.IsNullOrEmpty(loanId))
            {
                return BadRequest();
            }
            return Ok(_loans.Read(loanId));
        }

        [HttpPost("loans/{loanId}/settle")]
        public IActionResult Settle(string loanId)
        {
            var receipt = _loans.Settle(loanId);
            return Ok(receipt);
        }
    }
}
