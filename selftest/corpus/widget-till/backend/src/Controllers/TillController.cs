using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace WidgetTill.Api.Controllers
{
    [ApiController]
    [Route("till/v1")]
    public class TillController : ControllerBase
    {
        [HttpPost("refunds")]
        public async Task<IActionResult> Refund([FromBody] RefundRequest request)
        {
            if (request == null)
            {
                return BadRequest("a refund needs a body");
            }

            await Task.CompletedTask;
            return Ok();
        }
    }
}
